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

// cloakUpstream returns a DoH handler that answers every A query with a CNAME
// to cnameTarget followed by an A record.
func cloakUpstream(cnameTarget string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		if err := req.Unpack(body); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Answer = []dns.RR{
			&dns.CNAME{
				Hdr:    dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeCNAME, Class: dns.ClassINET, Ttl: 60},
				Target: cnameTarget,
			},
			&dns.A{
				Hdr: dns.RR_Header{Name: cnameTarget, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.IPv4(192, 0, 2, 7),
			},
		}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})
}

func cloakTestManager(t *testing.T, denylist, allowlist []string) *blocklist.Manager {
	t.Helper()
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Denylist:        denylist,
		Allowlist:       allowlist,
	}
	mgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	mgr.LoadOnce(nil)
	return mgr
}

func TestCnameCloakingBlocked(t *testing.T) {
	blMgr := cloakTestManager(t, []string{"tracker.evil.example"}, nil)
	srv := newHTTPServer(cloakUpstream("tracker.evil.example."))
	defer srv.Close()

	cfg := minimalResolverConfig(srv.URL)
	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	req := new(dns.Msg)
	req.SetQuestion("metrics.innocent.example.", dns.TypeA)
	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)

	if w.written == nil {
		t.Fatal("expected response")
	}
	if w.written.Rcode != dns.RcodeNameError {
		t.Errorf("Rcode = %s, want NXDOMAIN (blocked via CNAME cloaking)", dns.RcodeToString[w.written.Rcode])
	}
	if len(w.written.Answer) != 0 {
		t.Errorf("expected no answers in blocked response, got %d", len(w.written.Answer))
	}
}

func TestCnameCloakingAllowlistedQnameWins(t *testing.T) {
	blMgr := cloakTestManager(t, []string{"tracker.evil.example"}, []string{"metrics.innocent.example"})
	srv := newHTTPServer(cloakUpstream("tracker.evil.example."))
	defer srv.Close()

	cfg := minimalResolverConfig(srv.URL)
	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	req := new(dns.Msg)
	req.SetQuestion("metrics.innocent.example.", dns.TypeA)
	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)

	if w.written == nil {
		t.Fatal("expected response")
	}
	if w.written.Rcode != dns.RcodeSuccess || len(w.written.Answer) == 0 {
		t.Errorf("allowlisted qname should be served despite blocked CNAME target; rcode=%s answers=%d",
			dns.RcodeToString[w.written.Rcode], len(w.written.Answer))
	}
}

func TestCnameCloakingDisabled(t *testing.T) {
	blMgr := cloakTestManager(t, []string{"tracker.evil.example"}, nil)
	srv := newHTTPServer(cloakUpstream("tracker.evil.example."))
	defer srv.Close()

	cfg := minimalResolverConfig(srv.URL)
	cfg.Blocklists.BlockCnameCloaking = ptr(false)
	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	req := new(dns.Msg)
	req.SetQuestion("metrics.innocent.example.", dns.TypeA)
	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)

	if w.written == nil {
		t.Fatal("expected response")
	}
	if w.written.Rcode != dns.RcodeSuccess || len(w.written.Answer) == 0 {
		t.Error("with block_cname_cloaking=false the response should be served")
	}
}

func TestCnameCloakingHarmlessChainServed(t *testing.T) {
	blMgr := cloakTestManager(t, []string{"tracker.evil.example"}, nil)
	srv := newHTTPServer(cloakUpstream("cdn.legit.example."))
	defer srv.Close()

	cfg := minimalResolverConfig(srv.URL)
	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	req := new(dns.Msg)
	req.SetQuestion("www.innocent.example.", dns.TypeA)
	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)

	if w.written == nil {
		t.Fatal("expected response")
	}
	if w.written.Rcode != dns.RcodeSuccess || len(w.written.Answer) != 2 {
		t.Errorf("harmless CNAME chain should be served; rcode=%s answers=%d",
			dns.RcodeToString[w.written.Rcode], len(w.written.Answer))
	}
}

func TestCnameCloakTargetHelper(t *testing.T) {
	blMgr := cloakTestManager(t, []string{"tracker.evil.example"}, nil)
	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)
	w := &mockResponseWriter{}

	resp := new(dns.Msg)
	resp.SetQuestion("a.example.", dns.TypeA)
	resp.Answer = []dns.RR{
		&dns.CNAME{
			Hdr:    dns.RR_Header{Name: "a.example.", Rrtype: dns.TypeCNAME, Class: dns.ClassINET, Ttl: 60},
			Target: "sub.tracker.evil.example.",
		},
	}
	// Subdomains of a blocked domain are blocked too.
	if got := resolver.cnameCloakTarget(w, "a.example", resp); got != "sub.tracker.evil.example" {
		t.Errorf("cnameCloakTarget = %q, want sub.tracker.evil.example", got)
	}

	// No CNAMEs: no block, and no blocklist lookups needed.
	respNoCname := new(dns.Msg)
	respNoCname.SetQuestion("a.example.", dns.TypeA)
	respNoCname.Answer = []dns.RR{&dns.A{
		Hdr: dns.RR_Header{Name: "a.example.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
		A:   net.IPv4(192, 0, 2, 1),
	}}
	if got := resolver.cnameCloakTarget(w, "a.example", respNoCname); got != "" {
		t.Errorf("cnameCloakTarget = %q, want empty for response without CNAMEs", got)
	}
}
