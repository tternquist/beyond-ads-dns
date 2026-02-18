package dnsresolver

import (
	"bytes"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/miekg/dns"
	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/cache"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/localrecords"
	"github.com/tternquist/beyond-ads-dns/internal/requestlog"
)

// mockResponseWriter captures the written DNS message for inspection.
type mockResponseWriter struct {
	remoteAddr string
	written    *dns.Msg
}

func (m *mockResponseWriter) LocalAddr() net.Addr  { return &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 53} }
func (m *mockResponseWriter) RemoteAddr() net.Addr { return &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 12345} }
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
	blMgr := blocklist.NewManager(blCfg, log.New(io.Discard, "", 0))
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
	blMgr := blocklist.NewManager(blCfg, log.New(io.Discard, "", 0))
	blMgr.LoadOnce(nil)

	localEntries := []config.LocalRecordEntry{
		{Name: "local.test.example", Type: "A", Value: "192.168.1.100"},
	}
	localMgr := localrecords.New(localEntries, log.New(io.Discard, "", 0))

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
	blMgr := blocklist.NewManager(blCfg, log.New(io.Discard, "", 0))
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
	blMgr := blocklist.NewManager(blCfg, log.New(io.Discard, "", 0))
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
	blMgr := blocklist.NewManager(blCfg, log.New(io.Discard, "", 0))
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
	blMgr := blocklist.NewManager(blCfg, log.New(io.Discard, "", 0))
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
	blMgr := blocklist.NewManager(blCfg, log.New(io.Discard, "", 0))
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
	blMgr := blocklist.NewManager(blCfg, log.New(io.Discard, "", 0))
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

// TestUpstreamBackoffAllProtocols verifies backoff works for UDP, TCP, TLS, and DoH.
func TestUpstreamBackoffAllProtocols(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, log.New(io.Discard, "", 0))
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
		name    string
		fail    config.UpstreamConfig
		ok      config.UpstreamConfig
		timeout time.Duration
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
			if failCount != 1 {
				t.Errorf("after first query: failCount = %d, want 1", failCount)
			}

			doQuery()
			if failCount != 1 {
				t.Errorf("after second query (in backoff): failCount = %d, want 1 (should skip failed upstream)", failCount)
			}

			time.Sleep(250 * time.Millisecond)
			doQuery()
			if failCount != 2 {
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

func buildTestResolver(t *testing.T, cfg config.Config, cacheClient cache.DNSCache, blMgr *blocklist.Manager, localMgr *localrecords.Manager) *Resolver {
	t.Helper()
	if localMgr == nil {
		localMgr = localrecords.New(nil, log.New(io.Discard, "", 0))
	}
	reqLog := requestlog.NewWriter(&bytes.Buffer{}, "text")
	return New(cfg, cacheClient, localMgr, blMgr, log.New(io.Discard, "", 0), reqLog, nil)
}
