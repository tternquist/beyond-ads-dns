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

func newHTTPServer(handler http.Handler) *httptest.Server {
	return httptest.NewServer(handler)
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

func buildTestResolver(t *testing.T, cfg config.Config, cacheClient *cache.RedisCache, blMgr *blocklist.Manager, localMgr *localrecords.Manager) *Resolver {
	t.Helper()
	if localMgr == nil {
		localMgr = localrecords.New(nil, log.New(io.Discard, "", 0))
	}
	reqLog := requestlog.NewWriter(&bytes.Buffer{}, "text")
	return New(cfg, cacheClient, localMgr, blMgr, log.New(io.Discard, "", 0), reqLog, nil)
}
