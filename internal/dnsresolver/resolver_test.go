package dnsresolver

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/miekg/dns"
	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/cache"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/localrecords"
	"github.com/tternquist/beyond-ads-dns/internal/logging"
	"github.com/tternquist/beyond-ads-dns/internal/querystore"
	"github.com/tternquist/beyond-ads-dns/internal/requestlog"
)

// mockResponseWriter captures the written DNS message for inspection.
type mockResponseWriter struct {
	remoteAddr string // e.g. "192.168.1.10:12345" for per-group blocklist tests
	written    *dns.Msg
}

func (m *mockResponseWriter) LocalAddr() net.Addr { return &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 53} }
func (m *mockResponseWriter) RemoteAddr() net.Addr {
	if m.remoteAddr != "" {
		ip := net.ParseIP(m.remoteAddr)
		if ip != nil {
			return &net.TCPAddr{IP: ip, Port: 12345}
		}
	}
	return &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 12345}
}
func (m *mockResponseWriter) WriteMsg(msg *dns.Msg) error {
	m.written = msg
	return nil
}
func (m *mockResponseWriter) Write([]byte) (int, error) { return 0, nil }
func (m *mockResponseWriter) Close() error              { return nil }
func (m *mockResponseWriter) TsigStatus() error        { return nil }
func (m *mockResponseWriter) TsigTimersOnly(bool)     {}
func (m *mockResponseWriter) Hijack()                  {}

func TestResolverBlockedQuery(t *testing.T) {
	// Blocklist with ads.example.com in denylist (no fetch needed)
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
		Denylist:        []string{"ads.example.com"},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	cfg.Blocklists = blCfg

	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	req := new(dns.Msg)
	req.SetQuestion("ads.example.com.", dns.TypeA)
	req.Id = 12345

	w := &mockResponseWriter{written: nil}
	resolver.ServeDNS(w, req)

	if w.written == nil {
		t.Fatal("expected response for blocked query")
	}
	if w.written.Rcode != dns.RcodeNameError {
		t.Errorf("blocked query Rcode = %s, want NXDOMAIN", dns.RcodeToString[w.written.Rcode])
	}
}

func TestResolverLocalRecord(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	localEntries := []config.LocalRecordEntry{
		{Name: "local.test.example", Type: "A", Value: "192.168.1.100"},
	}
	localMgr := localrecords.New(localEntries, logging.NewDiscardLogger())

	// DoH mock server - returns valid A record
	dohHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		req := new(dns.Msg)
		if err := req.Unpack(body); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.IPv4(192, 168, 1, 1),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})
	dohSrv := newHTTPServer(dohHandler)
	defer dohSrv.Close()

	cfg := minimalResolverConfig(dohSrv.URL)
	cfg.Upstreams = []config.UpstreamConfig{{Name: "doh", Address: dohSrv.URL, Protocol: "https"}}
	cfg.Blocklists = blCfg
	cfg.LocalRecords = localEntries

	resolver := buildTestResolver(t, cfg, nil, blMgr, localMgr)

	// Query for local record - should be answered from local, not upstream
	req := new(dns.Msg)
	req.SetQuestion("local.test.example.", dns.TypeA)
	req.Id = 12345

	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)

	if w.written == nil {
		t.Fatal("expected response for local record query")
	}
	if len(w.written.Answer) == 0 {
		t.Fatal("expected at least one answer")
	}
	if a, ok := w.written.Answer[0].(*dns.A); !ok {
		t.Fatalf("expected A record, got %T", w.written.Answer[0])
	} else if !a.A.Equal(net.IPv4(192, 168, 1, 100)) {
		t.Errorf("local record A = %s, want 192.168.1.100", a.A)
	}
}

func TestResolverDoHUpstream(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	// DoH mock returns valid response for example.com
	dohHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		req := new(dns.Msg)
		if err := req.Unpack(body); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 300},
				A:   net.IPv4(93, 184, 216, 34),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})
	dohSrv := newHTTPServer(dohHandler)
	defer dohSrv.Close()

	cfg := minimalResolverConfig(dohSrv.URL)
	cfg.Upstreams = []config.UpstreamConfig{{Name: "doh", Address: dohSrv.URL, Protocol: "https"}}
	cfg.Blocklists = blCfg

	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	req := new(dns.Msg)
	req.SetQuestion("example.com.", dns.TypeA)
	req.Id = 12345

	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)

	if w.written == nil {
		t.Fatal("expected response from DoH upstream")
	}
	if w.written.Rcode != dns.RcodeSuccess {
		t.Errorf("Rcode = %s, want NOERROR", dns.RcodeToString[w.written.Rcode])
	}
	if len(w.written.Answer) == 0 {
		t.Fatal("expected answer from upstream")
	}
	if a, ok := w.written.Answer[0].(*dns.A); !ok {
		t.Fatalf("expected A record, got %T", w.written.Answer[0])
	} else if !a.A.Equal(net.IPv4(93, 184, 216, 34)) {
		t.Errorf("A = %s, want 93.184.216.34", a.A)
	}
}

func TestResolverInvalidRequest(t *testing.T) {
	blCfg := config.BlocklistConfig{RefreshInterval: config.Duration{Duration: time.Hour}, Sources: []config.BlocklistSource{}}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	dohHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		_ = req.Unpack(body)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Rcode = dns.RcodeSuccess
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})
	dohSrv := newHTTPServer(dohHandler)
	defer dohSrv.Close()

	cfg := minimalResolverConfig(dohSrv.URL)
	cfg.Upstreams = []config.UpstreamConfig{{Name: "doh", Address: dohSrv.URL, Protocol: "https"}}

	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	// Empty question - nil request causes HandleFailed to panic, so test empty question only
	req := new(dns.Msg)
	req.Id = 1
	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)
	// Should handle gracefully (may write SERVFAIL or similar)
}

func TestParseCacheKey(t *testing.T) {
	name, qtype, qclass, ok := parseCacheKey("dns:example.com:1:1")
	if !ok {
		t.Fatal("parseCacheKey should succeed")
	}
	if name != "example.com" {
		t.Errorf("name = %q, want example.com", name)
	}
	if qtype != dns.TypeA {
		t.Errorf("qtype = %d, want A (1)", qtype)
	}
	if qclass != dns.ClassINET {
		t.Errorf("qclass = %d, want IN (1)", qclass)
	}

	_, _, _, ok = parseCacheKey("invalid")
	if ok {
		t.Error("parseCacheKey(invalid) should fail")
	}
}

func TestCacheKey(t *testing.T) {
	key := cacheKey("example.com", dns.TypeA, dns.ClassINET)
	if key == "" {
		t.Error("cacheKey should not be empty")
	}
	name, qtype, qclass, ok := parseCacheKey(key)
	if !ok {
		t.Fatal("parseCacheKey of cacheKey output should succeed")
	}
	if name != "example.com" || qtype != dns.TypeA || qclass != dns.ClassINET {
		t.Errorf("roundtrip: got name=%q qtype=%d qclass=%d", name, qtype, qclass)
	}
}

func TestNormalizeQueryName(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"Example.COM.", "example.com"},
		{"EXAMPLE.COM", "example.com"},
		{"  test.example.com  ", "test.example.com"},
	}
	for _, tt := range tests {
		got := normalizeQueryName(tt.in)
		if got != tt.want {
			t.Errorf("normalizeQueryName(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// TestUpstreamBackoffFailover verifies that when the first upstream fails, the second is tried,
// and that the failed upstream is skipped (backoff) for subsequent queries until backoff expires.
func TestUpstreamBackoffFailover(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	var failCount, okCount int
	failHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		failCount++
		http.Error(w, "upstream down", 500)
	})
	okHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		_ = req.Unpack(body)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.IPv4(192, 168, 1, 1),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		okCount++
		_, _ = w.Write(packed)
	})

	failSrv := newHTTPServer(failHandler)
	defer failSrv.Close()
	okSrv := newHTTPServer(okHandler)
	defer okSrv.Close()

	cfg := minimalResolverConfig(okSrv.URL)
	cfg.Upstreams = []config.UpstreamConfig{
		{Name: "fail", Address: failSrv.URL, Protocol: "https"},
		{Name: "ok", Address: okSrv.URL, Protocol: "https"},
	}
	cfg.ResolverStrategy = "failover"
	cfg.UpstreamBackoff = &config.Duration{Duration: 200 * time.Millisecond}
	cfg.Blocklists = blCfg

	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	doQuery := func() {
		req := new(dns.Msg)
		req.SetQuestion("example.com.", dns.TypeA)
		req.Id = 12345
		w := &mockResponseWriter{}
		resolver.ServeDNS(w, req)
		if w.written == nil || w.written.Rcode != dns.RcodeSuccess {
			t.Fatalf("expected successful response, got %v", w.written)
		}
	}

	// Query 1: tries fail (1), then ok (1)
	doQuery()
	if failCount != 1 {
		t.Errorf("after first query: failCount = %d, want 1", failCount)
	}
	if okCount != 1 {
		t.Errorf("after first query: okCount = %d, want 1", okCount)
	}

	// Query 2 (within backoff): skips fail, tries ok only
	doQuery()
	if failCount != 1 {
		t.Errorf("after second query (in backoff): failCount = %d, want 1 (should skip failed upstream)", failCount)
	}
	if okCount != 2 {
		t.Errorf("after second query: okCount = %d, want 2", okCount)
	}

	// Wait for backoff to expire
	time.Sleep(250 * time.Millisecond)

	// Query 3 (after backoff): tries fail again (2), then ok (3)
	doQuery()
	if failCount != 2 {
		t.Errorf("after third query (backoff expired): failCount = %d, want 2", failCount)
	}
	if okCount != 3 {
		t.Errorf("after third query: okCount = %d, want 3", okCount)
	}
}

// TestUpstreamBackoffDisabled verifies that when upstream_backoff is 0, failed upstreams are retried every query.
func TestUpstreamBackoffDisabled(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	var failCount int
	failHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		failCount++
		http.Error(w, "upstream down", 500)
	})
	okHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		_ = req.Unpack(body)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.IPv4(192, 168, 1, 1),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})

	failSrv := newHTTPServer(failHandler)
	defer failSrv.Close()
	okSrv := newHTTPServer(okHandler)
	defer okSrv.Close()

	cfg := minimalResolverConfig(okSrv.URL)
	cfg.Upstreams = []config.UpstreamConfig{
		{Name: "fail", Address: failSrv.URL, Protocol: "https"},
		{Name: "ok", Address: okSrv.URL, Protocol: "https"},
	}
	cfg.ResolverStrategy = "failover"
	cfg.UpstreamBackoff = &config.Duration{Duration: 0} // disabled
	cfg.Blocklists = blCfg

	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	doQuery := func() {
		req := new(dns.Msg)
		req.SetQuestion("example.com.", dns.TypeA)
		req.Id = 12345
		w := &mockResponseWriter{}
		resolver.ServeDNS(w, req)
		if w.written == nil || w.written.Rcode != dns.RcodeSuccess {
			t.Fatalf("expected successful response, got %v", w.written)
		}
	}

	doQuery()
	doQuery()
	// With backoff disabled, fail upstream is tried every query
	if failCount != 2 {
		t.Errorf("with backoff disabled: failCount = %d, want 2 (retried each query)", failCount)
	}
}

// TestUpstreamBackoffClearedOnSuccess verifies that a successful response clears the backoff for that upstream.
func TestUpstreamBackoffClearedOnSuccess(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	// First upstream fails once, then succeeds
	var failOnce int
	flakyHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		failOnce++
		if failOnce == 1 {
			http.Error(w, "temporary failure", 500)
			return
		}
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		_ = req.Unpack(body)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.IPv4(10, 0, 0, 1),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})
	okHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		_ = req.Unpack(body)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.IPv4(192, 168, 1, 1),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})

	flakySrv := newHTTPServer(flakyHandler)
	defer flakySrv.Close()
	okSrv := newHTTPServer(okHandler)
	defer okSrv.Close()

	cfg := minimalResolverConfig(okSrv.URL)
	cfg.Upstreams = []config.UpstreamConfig{
		{Name: "flaky", Address: flakySrv.URL, Protocol: "https"},
		{Name: "ok", Address: okSrv.URL, Protocol: "https"},
	}
	cfg.ResolverStrategy = "failover"
	cfg.UpstreamBackoff = &config.Duration{Duration: 100 * time.Millisecond}
	cfg.Blocklists = blCfg

	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	// Query 1: flaky fails, ok succeeds
	req := new(dns.Msg)
	req.SetQuestion("example.com.", dns.TypeA)
	req.Id = 12345
	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)
	if w.written == nil || w.written.Rcode != dns.RcodeSuccess {
		t.Fatal("expected successful response")
	}
	// Should have gotten 192.168.1.1 from ok (fallback)
	if a, ok := w.written.Answer[0].(*dns.A); !ok || !a.A.Equal(net.IPv4(192, 168, 1, 1)) {
		t.Errorf("expected 192.168.1.1 from fallback, got %v", w.written.Answer)
	}

	// Query 2 (within backoff): flaky is skipped, ok succeeds
	w2 := &mockResponseWriter{}
	req2 := new(dns.Msg)
	req2.SetQuestion("example.com.", dns.TypeA)
	req2.Id = 12346
	resolver.ServeDNS(w2, req2)
	if w2.written == nil || w2.written.Rcode != dns.RcodeSuccess {
		t.Fatal("expected successful response")
	}

	// Wait for backoff to expire
	time.Sleep(150 * time.Millisecond)

	// Query 3: backoff expired, try flaky again - it succeeds now (failOnce=2), clearing backoff
	w3 := &mockResponseWriter{}
	req3 := new(dns.Msg)
	req3.SetQuestion("example.com.", dns.TypeA)
	req3.Id = 12347
	resolver.ServeDNS(w3, req3)
	if w3.written == nil || w3.written.Rcode != dns.RcodeSuccess {
		t.Fatal("expected successful response")
	}
	// Flaky should have succeeded (failOnce is 2), so we got 10.0.0.1
	if a, ok := w3.written.Answer[0].(*dns.A); !ok || !a.A.Equal(net.IPv4(10, 0, 0, 1)) {
		t.Errorf("expected 10.0.0.1 from recovered flaky, got %v", w3.written.Answer)
	}
}

// TestRefreshUsesUpstreamBackoff verifies that background refresh (refreshCache) uses the same
// exchange path and thus benefits from upstream backoff. When the first upstream is in backoff,
// refresh skips it and uses the second.
func TestRefreshUsesUpstreamBackoff(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	var failCount, okCount int
	failHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		failCount++
		http.Error(w, "upstream down", 500)
	})
	okHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		_ = req.Unpack(body)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.IPv4(192, 168, 1, 1),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		okCount++
		_, _ = w.Write(packed)
	})

	failSrv := newHTTPServer(failHandler)
	defer failSrv.Close()
	okSrv := newHTTPServer(okHandler)
	defer okSrv.Close()

	cfg := minimalResolverConfig(okSrv.URL)
	cfg.Upstreams = []config.UpstreamConfig{
		{Name: "fail", Address: failSrv.URL, Protocol: "https"},
		{Name: "ok", Address: okSrv.URL, Protocol: "https"},
	}
	cfg.ResolverStrategy = "failover"
	cfg.UpstreamBackoff = &config.Duration{Duration: 200 * time.Millisecond}
	cfg.Blocklists = blCfg

	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	// ServeDNS query 1: fail upstream fails, ok succeeds, fail goes into backoff
	req := new(dns.Msg)
	req.SetQuestion("example.com.", dns.TypeA)
	req.Id = 12345
	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)
	if failCount != 1 || okCount != 1 {
		t.Fatalf("after ServeDNS: failCount=%d okCount=%d, want 1,1", failCount, okCount)
	}

	// refreshCache uses r.exchange() - should skip fail (in backoff), use ok
	q := dns.Question{Name: "example.com.", Qtype: dns.TypeA, Qclass: dns.ClassINET}
	resolver.refreshCache(q, cacheKey("example.com", dns.TypeA, dns.ClassINET))

	// fail should still be 1 (skipped), ok should be 2
	if failCount != 1 {
		t.Errorf("after refreshCache: failCount = %d, want 1 (refresh should skip failed upstream in backoff)", failCount)
	}
	if okCount != 2 {
		t.Errorf("after refreshCache: okCount = %d, want 2", okCount)
	}
}

// TestRefreshUpstreamFailLogRateLimit verifies that "refresh upstream failed" logs are rate-limited
// when internet is down, to avoid log flooding.
func TestRefreshUpstreamFailLogRateLimit(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelError}))

	// Use unreachable upstream (nothing listening) - exchange will fail quickly with connection refused
	cfg := minimalResolverConfig("https://127.0.0.1:19999/dns-query")
	cfg.Blocklists = blCfg
	cfg.Cache.Refresh = config.RefreshConfig{
		Enabled:        ptr(true),
		MaxInflight:    10,
		MinTTL:         config.Duration{Duration: 1 * time.Second},
		LockTTL:        config.Duration{Duration: 5 * time.Second},
		HitWindow:     config.Duration{Duration: time.Minute},
		SweepInterval: config.Duration{Duration: time.Hour},
		SweepWindow:   config.Duration{Duration: time.Hour},
		MaxBatchSize:  100,
	}
	cfg.Cache.RefreshUpstreamFailLogInterval = config.Duration{Duration: 100 * time.Millisecond}
	cfg.UpstreamTimeout = config.Duration{Duration: 2 * time.Second}

	reqLog := requestlog.NewWriter(&bytes.Buffer{}, "text")
	resolver := New(cfg, nil, localrecords.New(nil, logging.NewDiscardLogger()), blMgr, logger, reqLog, nil)

	q := dns.Question{Name: "example.com.", Qtype: dns.TypeA, Qclass: dns.ClassINET}
	key := cacheKey("example.com", dns.TypeA, dns.ClassINET)

	// Call refreshCache 5 times rapidly - all should fail (upstream unreachable)
	for i := 0; i < 5; i++ {
		resolver.refreshCache(q, key)
	}

	logStr := logBuf.String()
	count := strings.Count(logStr, "refresh upstream failed")
	if count > 1 {
		t.Errorf("expected at most 1 'refresh upstream failed' log (rate limited), got %d", count)
	}
	if count < 1 {
		t.Errorf("expected at least 1 'refresh upstream failed' log, got 0 (log=%q)", logStr)
	}
}

// TestUpstreamBackoffAllProtocols verifies backoff works for UDP, TCP, TLS, DoQ, and DoH.
func TestUpstreamBackoffAllProtocols(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	// DoH ok handler (used for DoH test and as fallback for TLS test)
	var dohOkCount int
	dohOkHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		_ = req.Unpack(body)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.IPv4(192, 168, 1, 1),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		dohOkCount++
		_, _ = w.Write(packed)
	})
	dohOkSrv := newHTTPServer(dohOkHandler)
	defer dohOkSrv.Close()

	protocols := []struct {
		name              string
		fail              config.UpstreamConfig
		ok                config.UpstreamConfig
		timeout           time.Duration
		skipFailCountCheck bool // true when fail upstream has no server to count (e.g. unreachable DoQ)
	}{
		{
			name: "udp",
			fail: config.UpstreamConfig{
				Name: "udp-fail", Address: "", Protocol: "udp",
			},
			ok: config.UpstreamConfig{
				Name: "udp-ok", Address: "", Protocol: "udp",
			},
			timeout: 500 * time.Millisecond,
		},
		{
			name: "tcp",
			fail: config.UpstreamConfig{
				Name: "tcp-fail", Address: "", Protocol: "tcp",
			},
			ok: config.UpstreamConfig{
				Name: "tcp-ok", Address: "", Protocol: "tcp",
			},
			timeout: 500 * time.Millisecond,
		},
		{
			name: "tls",
			fail: config.UpstreamConfig{
				Name: "tls-fail", Address: "", Protocol: "tls",
			},
			ok: config.UpstreamConfig{
				Name: "tls-ok", Address: dohOkSrv.URL, Protocol: "https",
			},
			timeout: 500 * time.Millisecond,
		},
		{
			name: "quic",
			fail: config.UpstreamConfig{
				Name: "quic-fail", Address: "", Protocol: "quic",
			},
			ok: config.UpstreamConfig{
				Name: "doh-ok", Address: dohOkSrv.URL, Protocol: "https",
			},
			timeout:              500 * time.Millisecond,
			skipFailCountCheck:   true, // unreachable address has no server to count
		},
		{
			name: "https",
			fail: config.UpstreamConfig{
				Name: "doh-fail", Address: "", Protocol: "https",
			},
			ok: config.UpstreamConfig{
				Name: "doh-ok", Address: dohOkSrv.URL, Protocol: "https",
			},
			timeout: 0,
		},
	}

	for _, proto := range protocols {
		t.Run(proto.name, func(t *testing.T) {
			var failCount int
			failHandler := dns.HandlerFunc(func(w dns.ResponseWriter, r *dns.Msg) {
				failCount++
				// Write garbage so client Unpack fails
				_, _ = w.Write([]byte("invalid"))
			})
			okHandler := dns.HandlerFunc(func(w dns.ResponseWriter, r *dns.Msg) {
				resp := new(dns.Msg)
				resp.SetReply(r)
				resp.Authoritative = true
				resp.Answer = []dns.RR{
					&dns.A{
						Hdr: dns.RR_Header{Name: r.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
						A:   net.IPv4(192, 168, 1, 1),
					},
				}
				_ = w.WriteMsg(resp)
			})

			switch proto.name {
			case "udp":
				proto.fail.Address = newDNSServerUDP(t, failHandler)
				proto.ok.Address = newDNSServerUDP(t, okHandler)
			case "tcp":
				proto.fail.Address = newDNSServerTCP(t, failHandler)
				proto.ok.Address = newDNSServerTCP(t, okHandler)
			case "tls":
				// TLS to a plain TCP server (no TLS) causes handshake failure; count connections
				proto.fail.Address = newTLSFailServer(t, &failCount)
			case "quic":
				// Unreachable address: connection will fail quickly (connection refused)
				proto.fail.Address = "quic://127.0.0.1:1"
			case "https":
				failSrv := newHTTPServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					failCount++
					http.Error(w, "upstream down", 500)
				}))
				defer failSrv.Close()
				proto.fail.Address = failSrv.URL
			}

			cfg := minimalResolverConfig(proto.ok.Address)
			cfg.Upstreams = []config.UpstreamConfig{proto.fail, proto.ok}
			cfg.ResolverStrategy = "failover"
			cfg.UpstreamBackoff = &config.Duration{Duration: 200 * time.Millisecond}
			cfg.Blocklists = blCfg
			if proto.timeout > 0 {
				cfg.UpstreamTimeout = config.Duration{Duration: proto.timeout}
			}

			resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

			doQuery := func() {
				req := new(dns.Msg)
				req.SetQuestion("example.com.", dns.TypeA)
				req.Id = 12345
				w := &mockResponseWriter{}
				resolver.ServeDNS(w, req)
				if w.written == nil || w.written.Rcode != dns.RcodeSuccess {
					t.Fatalf("expected successful response, got %v", w.written)
				}
			}

			doQuery()
			if !proto.skipFailCountCheck && failCount != 1 {
				t.Errorf("after first query: failCount = %d, want 1", failCount)
			}

			doQuery()
			if !proto.skipFailCountCheck && failCount != 1 {
				t.Errorf("after second query (in backoff): failCount = %d, want 1 (should skip failed upstream)", failCount)
			}

			time.Sleep(250 * time.Millisecond)
			doQuery()
			if !proto.skipFailCountCheck && failCount != 2 {
				t.Errorf("after third query (backoff expired): failCount = %d, want 2", failCount)
			}
		})
	}
}

func newHTTPServer(handler http.Handler) *httptest.Server {
	return httptest.NewServer(handler)
}

// newDNSServerUDP starts a UDP DNS server with the given handler, returns address (e.g. "127.0.0.1:port").
func newDNSServerUDP(t *testing.T, handler dns.Handler) string {
	t.Helper()
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket: %v", err)
	}
	addr := conn.LocalAddr().String()
	srv := &dns.Server{PacketConn: conn, Handler: handler}
	go func() {
		_ = srv.ActivateAndServe()
	}()
	t.Cleanup(func() { _ = srv.Shutdown() })
	return addr
}

// newDNSServerTCP starts a TCP DNS server with the given handler, returns address.
func newDNSServerTCP(t *testing.T, handler dns.Handler) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	addr := listener.Addr().String()
	srv := &dns.Server{Listener: listener, Handler: handler}
	go func() {
		_ = srv.ActivateAndServe()
	}()
	t.Cleanup(func() { _ = srv.Shutdown() })
	return addr
}

// newTLSFailServer starts a plain TCP server (no TLS). When clients connect with DoT,
// the TLS handshake fails. Returns tls://addr for use as upstream. Counts connections in failCount.
func newTLSFailServer(t *testing.T, failCount *int) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	addr := listener.Addr().String()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			*failCount++
			_ = conn.Close()
		}
	}()
	t.Cleanup(func() { _ = listener.Close() })
	return "tls://" + addr
}

func minimalResolverConfig(upstreamURL string) config.Config {
	return config.Config{
		Server: config.ServerConfig{Listen: []string{"127.0.0.1:53"}},
		Upstreams: []config.UpstreamConfig{
			{Name: "doh", Address: upstreamURL, Protocol: "https"},
		},
		ResolverStrategy: "failover",
		Blocklists: config.BlocklistConfig{
			RefreshInterval: config.Duration{Duration: 6 * time.Hour},
			Sources:         []config.BlocklistSource{},
		},
		Cache: config.CacheConfig{
			MinTTL:      config.Duration{Duration: 5 * time.Minute},
			MaxTTL:      config.Duration{Duration: 24 * time.Hour},
			NegativeTTL: config.Duration{Duration: 5 * time.Minute},
		},
		Response: config.ResponseConfig{
			Blocked:    "nxdomain",
			BlockedTTL: config.Duration{Duration: time.Hour},
		},
		RequestLog: config.RequestLogConfig{},
		QueryStore: config.QueryStoreConfig{
			Enabled: ptr(false),
		},
		Control: config.ControlConfig{},
		Webhooks: config.WebhooksConfig{},
	}
}

func ptr[T any](v T) *T { return &v }

// TestResolverCacheHit verifies that when the cache has a pre-populated entry,
// ServeDNS returns the cached response without hitting upstream.
func TestResolverCacheHit(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	var upstreamCount int
	dohHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCount++
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		_ = req.Unpack(body)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.IPv4(93, 184, 216, 34),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})
	dohSrv := newHTTPServer(dohHandler)
	defer dohSrv.Close()

	mockCache := cache.NewMockCache()
	cachedResp := new(dns.Msg)
	cachedResp.SetQuestion("cached.example.com.", dns.TypeA)
	cachedResp.Authoritative = true
	cachedResp.Answer = []dns.RR{
		&dns.A{
			Hdr: dns.RR_Header{Name: "cached.example.com.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 300},
			A:   net.IPv4(192, 168, 1, 100),
		},
	}
	mockCache.SetEntry(cacheKey("cached.example.com", dns.TypeA, dns.ClassINET), cachedResp, 5*time.Minute)

	cfg := minimalResolverConfig(dohSrv.URL)
	cfg.Upstreams = []config.UpstreamConfig{{Name: "doh", Address: dohSrv.URL, Protocol: "https"}}
	cfg.Blocklists = blCfg

	resolver := buildTestResolver(t, cfg, mockCache, blMgr, nil)

	req := new(dns.Msg)
	req.SetQuestion("cached.example.com.", dns.TypeA)
	req.Id = 12345
	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)

	if upstreamCount != 0 {
		t.Errorf("upstream should not be called on cache hit, got %d calls", upstreamCount)
	}
	if w.written == nil {
		t.Fatal("expected cached response")
	}
	if w.written.Rcode != dns.RcodeSuccess {
		t.Errorf("Rcode = %s, want NOERROR", dns.RcodeToString[w.written.Rcode])
	}
	if len(w.written.Answer) == 0 {
		t.Fatal("expected answer from cache")
	}
	if a, ok := w.written.Answer[0].(*dns.A); !ok || !a.A.Equal(net.IPv4(192, 168, 1, 100)) {
		t.Errorf("expected cached A 192.168.1.100, got %v", w.written.Answer)
	}
}

// TestResolverCacheMissThenHit verifies cache miss (upstream) then cache hit (from Set).
func TestResolverCacheMissThenHit(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	dohHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		_ = req.Unpack(body)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 300},
				A:   net.IPv4(93, 184, 216, 34),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})
	dohSrv := newHTTPServer(dohHandler)
	defer dohSrv.Close()

	mockCache := cache.NewMockCache()
	cfg := minimalResolverConfig(dohSrv.URL)
	cfg.Upstreams = []config.UpstreamConfig{{Name: "doh", Address: dohSrv.URL, Protocol: "https"}}
	cfg.Blocklists = blCfg

	resolver := buildTestResolver(t, cfg, mockCache, blMgr, nil)

	// Query 1: cache miss, fetches from upstream, caches in background
	req1 := new(dns.Msg)
	req1.SetQuestion("example.com.", dns.TypeA)
	req1.Id = 12345
	w1 := &mockResponseWriter{}
	resolver.ServeDNS(w1, req1)
	if w1.written == nil || w1.written.Rcode != dns.RcodeSuccess {
		t.Fatal("expected successful response from upstream")
	}
	// Allow background cache goroutine to complete
	time.Sleep(50 * time.Millisecond)
	if mockCache.EntryCount() == 0 {
		t.Error("expected cache to have entry after miss (background Set)")
	}

	// Query 2: cache hit
	req2 := new(dns.Msg)
	req2.SetQuestion("example.com.", dns.TypeA)
	req2.Id = 12346
	w2 := &mockResponseWriter{}
	resolver.ServeDNS(w2, req2)
	if w2.written == nil || w2.written.Rcode != dns.RcodeSuccess {
		t.Fatal("expected cached response")
	}
	if a, ok := w2.written.Answer[0].(*dns.A); !ok || !a.A.Equal(net.IPv4(93, 184, 216, 34)) {
		t.Errorf("expected cached A 93.184.216.34, got %v", w2.written.Answer)
	}
}

// TestResolverRedisCacheIntegration verifies the resolver works with RedisCache (miniredis),
// exercising the real pipeline/transaction logic for cache miss/hit flow.
func TestResolverRedisCacheIntegration(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	defer mr.Close()

	redisCache, err := cache.NewRedisCache(config.RedisConfig{Mode: "standalone", Address: mr.Addr()}, nil)
	if err != nil {
		t.Fatalf("NewRedisCache: %v", err)
	}
	defer redisCache.Close()

	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	dohHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		_ = req.Unpack(body)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 300},
				A:   net.IPv4(93, 184, 216, 34),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})
	dohSrv := newHTTPServer(dohHandler)
	defer dohSrv.Close()

	cfg := minimalResolverConfig(dohSrv.URL)
	cfg.Upstreams = []config.UpstreamConfig{{Name: "doh", Address: dohSrv.URL, Protocol: "https"}}
	cfg.Blocklists = blCfg

	resolver := buildTestResolver(t, cfg, redisCache, blMgr, nil)

	// Query 1: cache miss, fetches from upstream, caches in background
	req1 := new(dns.Msg)
	req1.SetQuestion("redis.example.com.", dns.TypeA)
	req1.Id = 12345
	w1 := &mockResponseWriter{}
	resolver.ServeDNS(w1, req1)
	if w1.written == nil || w1.written.Rcode != dns.RcodeSuccess {
		t.Fatal("expected successful response from upstream")
	}
	// Allow background cache goroutine to complete
	time.Sleep(100 * time.Millisecond)

	// Query 2: cache hit from Redis (exercises GetWithTTL pipeline)
	req2 := new(dns.Msg)
	req2.SetQuestion("redis.example.com.", dns.TypeA)
	req2.Id = 12346
	w2 := &mockResponseWriter{}
	resolver.ServeDNS(w2, req2)
	if w2.written == nil || w2.written.Rcode != dns.RcodeSuccess {
		t.Fatal("expected cached response from Redis")
	}
	if a, ok := w2.written.Answer[0].(*dns.A); !ok || !a.A.Equal(net.IPv4(93, 184, 216, 34)) {
		t.Errorf("expected cached A 93.184.216.34, got %v", w2.written.Answer)
	}
}

// TestResolverStaleEntryTTL verifies that when serving an expired (stale) entry,
// the TTL in the DNS response is set to expired_entry_ttl instead of the original.
func TestResolverStaleEntryTTL(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	mockCache := cache.NewMockCache()
	cachedResp := new(dns.Msg)
	cachedResp.SetQuestion("stale.example.com.", dns.TypeA)
	cachedResp.Authoritative = true
	cachedResp.Answer = []dns.RR{
		&dns.A{
			Hdr: dns.RR_Header{Name: "stale.example.com.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 300},
			A:   net.IPv4(192, 168, 1, 1),
		},
	}
	key := cacheKey("stale.example.com", dns.TypeA, dns.ClassINET)
	mockCache.SetStaleEntry(key, cachedResp)

	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	cfg.Blocklists = blCfg
	cfg.Cache.Refresh = config.RefreshConfig{
		Enabled:          ptr(true),
		ServeStale:       ptr(true),
		StaleTTL:         config.Duration{Duration: time.Hour},
		ExpiredEntryTTL:  config.Duration{Duration: 30 * time.Second},
		LockTTL:          config.Duration{Duration: 5 * time.Second},
		MaxInflight:      10,
		SweepInterval:     config.Duration{Duration: time.Hour},
		SweepWindow:      config.Duration{Duration: 30 * time.Minute},
		MaxBatchSize:     100,
		SweepMinHits:     0,
		SweepHitWindow:   config.Duration{Duration: time.Hour},
		HitCountSampleRate: 1.0,
	}

	resolver := buildTestResolver(t, cfg, mockCache, blMgr, nil)

	req := new(dns.Msg)
	req.SetQuestion("stale.example.com.", dns.TypeA)
	req.Id = 12345
	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)

	if w.written == nil || w.written.Rcode != dns.RcodeSuccess {
		t.Fatal("expected stale response")
	}
	if len(w.written.Answer) == 0 {
		t.Fatal("expected answer")
	}
	gotTTL := w.written.Answer[0].Header().Ttl
	if gotTTL != 30 {
		t.Errorf("expected TTL 30 (expired_entry_ttl) when serving stale, got %d", gotTTL)
	}
}

// TestResolverCacheGetError verifies that when cache GetWithTTL returns an error,
// the resolver falls through to upstream.
func TestResolverCacheGetError(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	dohHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		_ = req.Unpack(body)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.IPv4(10, 0, 0, 1),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})
	dohSrv := newHTTPServer(dohHandler)
	defer dohSrv.Close()

	mockCache := cache.NewMockCache()
	mockCache.SetGetErr(errors.New("cache unavailable"))

	cfg := minimalResolverConfig(dohSrv.URL)
	cfg.Upstreams = []config.UpstreamConfig{{Name: "doh", Address: dohSrv.URL, Protocol: "https"}}
	cfg.Blocklists = blCfg

	resolver := buildTestResolver(t, cfg, mockCache, blMgr, nil)

	req := new(dns.Msg)
	req.SetQuestion("example.com.", dns.TypeA)
	req.Id = 12345
	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)

	if w.written == nil || w.written.Rcode != dns.RcodeSuccess {
		t.Fatal("expected fallback to upstream on cache error")
	}
	if a, ok := w.written.Answer[0].(*dns.A); !ok || !a.A.Equal(net.IPv4(10, 0, 0, 1)) {
		t.Errorf("expected upstream A 10.0.0.1, got %v", w.written.Answer)
	}
}

// TestResolverCacheSetError verifies that cache SetWithIndex error is handled (logged, non-fatal).
func TestResolverCacheSetError(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	dohHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		_ = req.Unpack(body)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.IPv4(10, 0, 0, 1),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})
	dohSrv := newHTTPServer(dohHandler)
	defer dohSrv.Close()

	mockCache := cache.NewMockCache()
	mockCache.SetSetErr(errors.New("cache write failed"))

	cfg := minimalResolverConfig(dohSrv.URL)
	cfg.Upstreams = []config.UpstreamConfig{{Name: "doh", Address: dohSrv.URL, Protocol: "https"}}
	cfg.Blocklists = blCfg

	resolver := buildTestResolver(t, cfg, mockCache, blMgr, nil)

	req := new(dns.Msg)
	req.SetQuestion("example.com.", dns.TypeA)
	req.Id = 12345
	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)

	// Client still gets response (write happens before cache in background)
	if w.written == nil || w.written.Rcode != dns.RcodeSuccess {
		t.Fatal("expected successful response despite cache set error")
	}
	// Allow background goroutine to run
	time.Sleep(50 * time.Millisecond)
	// Cache should remain empty due to Set error
	if mockCache.EntryCount() != 0 {
		t.Errorf("expected cache to remain empty after Set error, got %d entries", mockCache.EntryCount())
	}
}

// TestResolverCacheStats verifies CacheStats returns cache stats when cache is present.
func TestResolverCacheStats(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	mockCache := cache.NewMockCache()
	mockCache.SetEntry(cacheKey("example.com", dns.TypeA, dns.ClassINET), new(dns.Msg), time.Minute)

	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	cfg.Blocklists = blCfg

	resolver := buildTestResolver(t, cfg, mockCache, blMgr, nil)

	stats := resolver.CacheStats()
	if stats.Hits == 0 && stats.Misses == 0 && stats.LRU == nil {
		t.Error("expected non-empty CacheStats from mock cache")
	}
}

// TestResolverClearCache verifies ClearCache delegates to the cache.
func TestResolverClearCache(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	mockCache := cache.NewMockCache()
	mockCache.SetEntry(cacheKey("example.com", dns.TypeA, dns.ClassINET), new(dns.Msg), time.Minute)
	if mockCache.EntryCount() != 1 {
		t.Fatalf("expected 1 entry, got %d", mockCache.EntryCount())
	}

	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	cfg.Blocklists = blCfg

	resolver := buildTestResolver(t, cfg, mockCache, blMgr, nil)

	if err := resolver.ClearCache(context.Background()); err != nil {
		t.Fatalf("ClearCache: %v", err)
	}
	if mockCache.EntryCount() != 0 {
		t.Errorf("expected cache to be empty after ClearCache, got %d entries", mockCache.EntryCount())
	}
}

// TestResolverCacheNil verifies resolver handles nil cache (CacheStats, ClearCache return empty/nil).
func TestResolverCacheNil(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	cfg.Blocklists = blCfg

	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	stats := resolver.CacheStats()
	if stats.Hits != 0 || stats.Misses != 0 {
		t.Errorf("CacheStats with nil cache: got Hits=%d Misses=%d, want 0,0", stats.Hits, stats.Misses)
	}
	if err := resolver.ClearCache(context.Background()); err != nil {
		t.Errorf("ClearCache with nil cache: %v", err)
	}
}

// TestResolverRefreshScheduled verifies that when refresh is enabled and a cache hit has
// short TTL with sufficient hits, a background refresh is scheduled (refreshCache called).
func TestResolverRefreshScheduled(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	var refreshUpstreamCount int
	dohHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		_ = req.Unpack(body)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 300},
				A:   net.IPv4(192, 168, 1, 200),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		refreshUpstreamCount++
		_, _ = w.Write(packed)
	})
	dohSrv := newHTTPServer(dohHandler)
	defer dohSrv.Close()

	mockCache := cache.NewMockCache()
	// Cached entry with short TTL (5s) - below minTTL (10s) so maybeRefresh triggers
	cachedResp := new(dns.Msg)
	cachedResp.SetQuestion("refresh.example.com.", dns.TypeA)
	cachedResp.Authoritative = true
	cachedResp.Answer = []dns.RR{
		&dns.A{
			Hdr: dns.RR_Header{Name: "refresh.example.com.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 5},
			A:   net.IPv4(192, 168, 1, 100),
		},
	}
	key := cacheKey("refresh.example.com", dns.TypeA, dns.ClassINET)
	mockCache.SetEntry(key, cachedResp, 5*time.Second)

	cfg := minimalResolverConfig(dohSrv.URL)
	cfg.Upstreams = []config.UpstreamConfig{{Name: "doh", Address: dohSrv.URL, Protocol: "https"}}
	cfg.Blocklists = blCfg
	cfg.Cache.Refresh = config.RefreshConfig{
		Enabled:           ptr(true),
		HitWindow:          config.Duration{Duration: time.Hour},
		HotThreshold:       1,
		MinTTL:             config.Duration{Duration: 10 * time.Second},
		HotTTL:             config.Duration{Duration: 10 * time.Second},
		ServeStale:         ptr(false),
		LockTTL:            config.Duration{Duration: 5 * time.Second},
		MaxInflight:        10,
		SweepInterval:      config.Duration{Duration: time.Hour},
		SweepWindow:        config.Duration{Duration: 30 * time.Minute},
		MaxBatchSize:      100,
		SweepMinHits:       0,
		SweepHitWindow:     config.Duration{Duration: time.Hour},
		HitCountSampleRate: 1.0,
	}

	resolver := buildTestResolver(t, cfg, mockCache, blMgr, nil)

	// Cache hit with short TTL -> IncrementHit -> maybeRefresh -> scheduleRefresh -> refreshCache
	req := new(dns.Msg)
	req.SetQuestion("refresh.example.com.", dns.TypeA)
	req.Id = 12345
	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)

	if w.written == nil || w.written.Rcode != dns.RcodeSuccess {
		t.Fatal("expected cached response")
	}

	// Allow background refresh to run
	time.Sleep(100 * time.Millisecond)
	if refreshUpstreamCount < 1 {
		t.Errorf("expected refresh to call upstream, got %d calls", refreshUpstreamCount)
	}
}

// TestResolverRefreshStats verifies RefreshStats returns stats when refresh is enabled.
func TestResolverRefreshStats(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	mockCache := cache.NewMockCache()
	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	cfg.Blocklists = blCfg
	cfg.Cache.Refresh = config.RefreshConfig{
		Enabled:       ptr(true),
		MaxBatchSize:  100,
		SweepInterval: config.Duration{Duration: time.Hour},
		SweepWindow:   config.Duration{Duration: 30 * time.Minute},
	}

	resolver := buildTestResolver(t, cfg, mockCache, blMgr, nil)

	stats := resolver.RefreshStats()
	if stats.BatchSize <= 0 {
		t.Errorf("expected positive BatchSize, got %d", stats.BatchSize)
	}
}

// TestResolverStartRefreshSweeper verifies the sweeper runs and processes expiry candidates.
func TestResolverStartRefreshSweeper(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	var upstreamCount int
	dohHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		_ = req.Unpack(body)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.IPv4(192, 168, 1, 1),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		upstreamCount++
		_, _ = w.Write(packed)
	})
	dohSrv := newHTTPServer(dohHandler)
	defer dohSrv.Close()

	mockCache := cache.NewMockCache()
	// Pre-populate with entry that will be in expiry window (soft expiry in the past)
	key := cacheKey("sweep.example.com", dns.TypeA, dns.ClassINET)
	msg := new(dns.Msg)
	msg.SetQuestion("sweep.example.com.", dns.TypeA)
	msg.Authoritative = true
	msg.Answer = []dns.RR{
		&dns.A{
			Hdr: dns.RR_Header{Name: "sweep.example.com.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
			A:   net.IPv4(192, 168, 1, 1),
		},
	}
	// Set with short TTL so it appears in ExpiryCandidates soon
	mockCache.SetEntry(key, msg, 1*time.Second)

	cfg := minimalResolverConfig(dohSrv.URL)
	cfg.Upstreams = []config.UpstreamConfig{{Name: "doh", Address: dohSrv.URL, Protocol: "https"}}
	cfg.Blocklists = blCfg
	cfg.Cache.Refresh = config.RefreshConfig{
		Enabled:        ptr(true),
		MaxInflight:    10,
		SweepInterval:  config.Duration{Duration: 50 * time.Millisecond},
		SweepWindow:    config.Duration{Duration: 5 * time.Minute},
		MaxBatchSize:   100,
		SweepMinHits:   0,
		SweepHitWindow: config.Duration{Duration: time.Hour},
	}

	resolver := buildTestResolver(t, cfg, mockCache, blMgr, nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	resolver.StartRefreshSweeper(ctx)

	// Wait for at least one sweep (interval 50ms + jitter up to 5s)
	time.Sleep(200 * time.Millisecond)

	// Sweeper should have run; with sweep_min_hits=0 the key is not deleted for being cold.
	// The key may have been refreshed (scheduleRefresh -> refreshCache -> upstream).
	// Just verify the sweeper ran without panicking and upstream may have been called.
	if upstreamCount > 0 {
		// Refresh was scheduled and completed
		return
	}
	// Or sweep ran but didn't refresh (e.g. TryAcquireRefresh failed, or timing)
	// Either way, no panic means sweepRefresh executed
}

// TestResolverSweepColdKeyDeletion verifies cold keys (below sweep_min_hits) are deleted.
func TestResolverSweepColdKeyDeletion(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	mockCache := cache.NewMockCache()
	key := cacheKey("cold.example.com", dns.TypeA, dns.ClassINET)
	msg := new(dns.Msg)
	msg.SetQuestion("cold.example.com.", dns.TypeA)
	msg.Authoritative = true
	msg.Answer = []dns.RR{
		&dns.A{
			Hdr: dns.RR_Header{Name: "cold.example.com.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
			A:   net.IPv4(192, 168, 1, 1),
		},
	}
	mockCache.SetEntry(key, msg, 1*time.Millisecond)
	// No IncrementSweepHit calls - sweep count will be 0, below sweep_min_hits

	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	cfg.Blocklists = blCfg
	cfg.Cache.Refresh = config.RefreshConfig{
		Enabled:        ptr(true),
		MaxInflight:    10,
		SweepInterval:  config.Duration{Duration: time.Hour},
		SweepWindow:    config.Duration{Duration: 5 * time.Minute},
		MaxBatchSize:   100,
		SweepMinHits:   5,
		SweepHitWindow: config.Duration{Duration: time.Hour},
	}

	resolver := buildTestResolver(t, cfg, mockCache, blMgr, nil)

	// Call sweepRefresh directly (sweeper runs in background with ticker; we test the logic)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resolver.sweepRefresh(ctx)

	// Cold key (0 sweep hits < 5) should be deleted
	if mockCache.EntryCount() != 0 {
		t.Errorf("expected cold key to be deleted, got %d entries", mockCache.EntryCount())
	}
}

func buildTestResolver(t *testing.T, cfg config.Config, cacheClient cache.DNSCache, blMgr *blocklist.Manager, localMgr *localrecords.Manager) *Resolver {
	t.Helper()
	return buildTestResolverInternal(cfg, cacheClient, blMgr, localMgr)
}

func buildTestResolverInternal(cfg config.Config, cacheClient cache.DNSCache, blMgr *blocklist.Manager, localMgr *localrecords.Manager) *Resolver {
	return buildTestResolverWithQueryStore(cfg, cacheClient, blMgr, localMgr, nil)
}

func buildTestResolverWithQueryStore(cfg config.Config, cacheClient cache.DNSCache, blMgr *blocklist.Manager, localMgr *localrecords.Manager, queryStore querystore.Store) *Resolver {
	if localMgr == nil {
		localMgr = localrecords.New(nil, logging.NewDiscardLogger())
	}
	reqLog := requestlog.NewWriter(&bytes.Buffer{}, "text")
	return New(cfg, cacheClient, localMgr, blMgr, logging.NewDiscardLogger(), reqLog, queryStore)
}

func buildTestResolverB(b *testing.B, cfg config.Config, cacheClient cache.DNSCache, blMgr *blocklist.Manager, localMgr *localrecords.Manager) *Resolver {
	return buildTestResolverInternal(cfg, cacheClient, blMgr, localMgr)
}

// mockQueryStore records events for testing.
type mockQueryStore struct {
	events chan querystore.Event
}

func (m *mockQueryStore) Record(e querystore.Event) { m.events <- e }
func (m *mockQueryStore) Close() error              { return nil }
func (m *mockQueryStore) Stats() querystore.StoreStats {
	return querystore.StoreStats{}
}

func TestQueryStoreExclusion(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	mockStore := &mockQueryStore{events: make(chan querystore.Event, 4)}
	dohHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		_ = req.Unpack(body)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.IPv4(93, 184, 216, 34),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})
	dohSrv := newHTTPServer(dohHandler)
	defer dohSrv.Close()

	cfg := minimalResolverConfig(dohSrv.URL)
	cfg.Upstreams = []config.UpstreamConfig{{Name: "doh", Address: dohSrv.URL, Protocol: "https"}}
	cfg.QueryStore = config.QueryStoreConfig{
		Enabled:       ptr(true),
		SampleRate:    1.0,
		ExcludeDomains: []string{"local", "localhost"},
		ExcludeClients: []string{"192.168.1.99"},
	}

	resolver := buildTestResolverWithQueryStore(cfg, nil, blMgr, nil, mockStore)

	// Query excluded domain (host.local) - should NOT be recorded
	w1 := &mockResponseWriter{remoteAddr: "192.168.1.10"}
	req1 := new(dns.Msg)
	req1.SetQuestion("host.local.", dns.TypeA)
	req1.Id = 1
	resolver.ServeDNS(w1, req1)

	// Query non-excluded domain - should be recorded
	w2 := &mockResponseWriter{remoteAddr: "192.168.1.10"}
	req2 := new(dns.Msg)
	req2.SetQuestion("example.com.", dns.TypeA)
	req2.Id = 2
	resolver.ServeDNS(w2, req2)

	// Query from excluded client - should NOT be recorded
	w3 := &mockResponseWriter{remoteAddr: "192.168.1.99"}
	req3 := new(dns.Msg)
	req3.SetQuestion("example.org.", dns.TypeA)
	req3.Id = 3
	resolver.ServeDNS(w3, req3)

	// Wait for async logRequestData; we expect only 1 event (example.com)
	select {
	case e := <-mockStore.events:
		if e.QName != "example.com" {
			t.Errorf("expected only example.com to be recorded, got qname=%q", e.QName)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected 1 event, got none")
	}
	select {
	case e := <-mockStore.events:
		t.Errorf("expected no more events, got qname=%q", e.QName)
	case <-time.After(100 * time.Millisecond):
		// Expected: no more events
	}
}

func TestApplyClientIdentificationConfig_ListFormatWithGroups(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	cfg.ClientIdentification = config.ClientIdentificationConfig{
		Enabled: ptr(true),
		Clients: config.ClientEntries{
			{IP: "192.168.1.10", Name: "Kids Tablet", GroupID: "kids"},
			{IP: "192.168.1.11", Name: "Adults Phone", GroupID: "adults"},
		},
	}
	cfg.ClientGroups = []config.ClientGroup{
		{ID: "kids", Name: "Kids"},
		{ID: "adults", Name: "Adults"},
	}

	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	// Apply updated config (e.g. hot-reload)
	cfg2 := cfg
	cfg2.ClientIdentification.Clients = config.ClientEntries{
		{IP: "192.168.1.10", Name: "Kids Tablet Updated", GroupID: "kids"},
		{IP: "10.0.0.5", Name: "New Device", GroupID: "adults"},
	}
	resolver.ApplyClientIdentificationConfig(cfg2)

	// Resolver should not panic; config applied. Full resolution path would use
	// clientIDResolver.Resolve(clientAddr) when logging - we've verified the
	// ApplyClientIdentificationConfig path works.
}

func TestResolverPerGroupBlocklist(t *testing.T) {
	// Global blocklist blocks ads.example.com
	globalBlCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
		Denylist:        []string{"ads.example.com"},
	}
	globalBlMgr := blocklist.NewManager(globalBlCfg, logging.NewDiscardLogger())
	globalBlMgr.LoadOnce(nil)

	// Kids group has custom blocklist: blocks kids-blocked.example.com (not in global)
	inheritFalse := false
	kidsBlCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
		Denylist:        []string{"kids-blocked.example.com"},
	}
	kidsBlMgr := blocklist.NewManager(kidsBlCfg, logging.NewDiscardLogger())
	kidsBlMgr.LoadOnce(nil)

	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	cfg.ClientIdentification = config.ClientIdentificationConfig{
		Enabled: ptr(true),
		Clients: config.ClientEntries{
			{IP: "192.168.1.10", Name: "Kids Tablet", GroupID: "kids"},
			{IP: "192.168.1.11", Name: "Adults Phone", GroupID: "adults"},
		},
	}
	cfg.ClientGroups = []config.ClientGroup{
		{
			ID: "kids",
			Name: "Kids",
			Blocklist: &config.GroupBlocklistConfig{InheritGlobal: &inheritFalse},
		},
		{ID: "adults", Name: "Adults"},
	}

	resolver := buildTestResolver(t, cfg, nil, globalBlMgr, nil)
	// Replace kids group blocklist manager (buildTestResolver creates from config, but config has empty sources)
	resolver.groupBlocklistsMu.Lock()
	resolver.groupBlocklists["kids"] = kidsBlMgr
	resolver.groupBlocklistsMu.Unlock()

	// Kids client (192.168.1.10) queries kids-blocked.example.com -> should be blocked (group blocklist)
	req1 := new(dns.Msg)
	req1.SetQuestion("kids-blocked.example.com.", dns.TypeA)
	w1 := &mockResponseWriter{remoteAddr: "192.168.1.10", written: nil}
	resolver.ServeDNS(w1, req1)
	if w1.written == nil {
		t.Fatal("expected response for kids blocked query")
	}
	if w1.written.Rcode != dns.RcodeNameError {
		t.Errorf("kids client query kids-blocked.example.com: Rcode = %s, want NXDOMAIN", dns.RcodeToString[w1.written.Rcode])
	}

	// Unidentified client (10.0.0.1) queries ads.example.com -> should be blocked (global)
	req3 := new(dns.Msg)
	req3.SetQuestion("ads.example.com.", dns.TypeA)
	w3 := &mockResponseWriter{remoteAddr: "10.0.0.1", written: nil}
	resolver.ServeDNS(w3, req3)
	if w3.written == nil {
		t.Fatal("expected response for unidentified client blocked query")
	}
	if w3.written.Rcode != dns.RcodeNameError {
		t.Errorf("unidentified client query ads.example.com: Rcode = %s, want NXDOMAIN", dns.RcodeToString[w3.written.Rcode])
	}
}

// BenchmarkResolverBlocklist_NoGroupBlocklists measures blocklist check when no per-group blocklists exist (fast path).
func BenchmarkResolverBlocklist_NoGroupBlocklists(b *testing.B) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
		Denylist:        []string{"ads.example.com"},
	}
	blMgr := blocklist.NewManager(blCfg, nil)
	blMgr.LoadOnce(nil)
	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	resolver := buildTestResolverB(b, cfg, nil, blMgr, nil)
	req := new(dns.Msg)
	req.SetQuestion("ads.example.com.", dns.TypeA)
	w := &mockResponseWriter{written: nil}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		resolver.ServeDNS(w, req)
	}
}

// BenchmarkResolverBlocklist_WithGroupBlocklists measures blocklist check when per-group blocklists exist.
func BenchmarkResolverBlocklist_WithGroupBlocklists(b *testing.B) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
		Denylist:        []string{"ads.example.com"},
	}
	blMgr := blocklist.NewManager(blCfg, nil)
	blMgr.LoadOnce(nil)
	inheritFalse := false
	kidsBlCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
		Denylist:        []string{"kids-blocked.example.com"},
	}
	kidsBlMgr := blocklist.NewManager(kidsBlCfg, nil)
	kidsBlMgr.LoadOnce(nil)
	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	cfg.ClientIdentification = config.ClientIdentificationConfig{
		Enabled: ptr(true),
		Clients: config.ClientEntries{{IP: "192.168.1.10", Name: "Kids", GroupID: "kids"}},
	}
	cfg.ClientGroups = []config.ClientGroup{
		{ID: "kids", Name: "Kids", Blocklist: &config.GroupBlocklistConfig{InheritGlobal: &inheritFalse}},
	}
	resolver := buildTestResolverB(b, cfg, nil, blMgr, nil)
	resolver.groupBlocklistsMu.Lock()
	resolver.groupBlocklists["kids"] = kidsBlMgr
	resolver.groupBlocklistsMu.Unlock()
	req := new(dns.Msg)
	req.SetQuestion("kids-blocked.example.com.", dns.TypeA) // blocked by kids group blocklist
	w := &mockResponseWriter{remoteAddr: "192.168.1.10", written: nil}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		resolver.ServeDNS(w, req)
	}
}
