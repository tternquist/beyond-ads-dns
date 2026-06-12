package dnsresolver

import (
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/miekg/dns"
	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/logging"
)

// TestFailoverDeadUpstreamFastWithAttemptTimeout verifies that a dead first
// upstream is abandoned after the per-attempt timeout instead of the full
// upstream timeout, so the second upstream answers quickly.
func TestFailoverDeadUpstreamFastWithAttemptTimeout(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	dohHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		if err := req.Unpack(body); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Answer = []dns.RR{&dns.A{
			Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
			A:   net.IPv4(192, 0, 2, 1),
		}}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})
	dohSrv := newHTTPServer(dohHandler)
	defer dohSrv.Close()

	cfg := minimalResolverConfig(dohSrv.URL)
	// First upstream is a blackhole (TEST-NET-1, RFC 5737): never answers.
	cfg.Upstreams = []config.UpstreamConfig{
		{Name: "dead", Address: "192.0.2.1:53", Protocol: "udp"},
		{Name: "live", Address: dohSrv.URL, Protocol: "https"},
	}
	cfg.Network.UpstreamTimeout = config.Duration{Duration: 10 * time.Second}
	cfg.Network.UpstreamAttemptTimeout = &config.Duration{Duration: 200 * time.Millisecond}
	// Disable backoff so the test exercises the live failover path.
	cfg.Network.UpstreamBackoff = &config.Duration{}

	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	req := new(dns.Msg)
	req.SetQuestion("failover-test.example.", dns.TypeA)
	w := &mockResponseWriter{}
	start := time.Now()
	resolver.ServeDNS(w, req)
	elapsed := time.Since(start)

	if w.written == nil {
		t.Fatal("expected response")
	}
	if w.written.Rcode != dns.RcodeSuccess || len(w.written.Answer) == 0 {
		t.Fatalf("expected answer from second upstream; rcode=%s answers=%d",
			dns.RcodeToString[w.written.Rcode], len(w.written.Answer))
	}
	// Generous bound: attempt timeout 200ms + DoH round trip, far below the 10s full timeout.
	if elapsed > 3*time.Second {
		t.Errorf("failover took %v, want well under the full upstream timeout", elapsed)
	}
}
