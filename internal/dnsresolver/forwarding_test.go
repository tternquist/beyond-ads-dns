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

// answeringUpstream returns a DoH handler answering with the given IP and
// recording the names it was asked for.
func answeringUpstream(ip net.IP, asked *[]string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		if err := req.Unpack(body); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		*asked = append(*asked, req.Question[0].Name)
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Answer = []dns.RR{&dns.A{
			Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
			A:   ip,
		}}
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})
}

func TestForwardingRuleRouting(t *testing.T) {
	blCfg := config.BlocklistConfig{RefreshInterval: config.Duration{Duration: time.Hour}}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	var globalAsked, lanAsked []string
	globalSrv := newHTTPServer(answeringUpstream(net.IPv4(192, 0, 2, 1), &globalAsked))
	defer globalSrv.Close()
	lanSrv := newHTTPServer(answeringUpstream(net.IPv4(192, 168, 1, 1), &lanAsked))
	defer lanSrv.Close()

	cfg := minimalResolverConfig(globalSrv.URL)
	cfg.ForwardingRules = []config.ForwardingRule{
		{
			Name:      "home-network",
			Domains:   []string{"lan", "home.arpa"},
			Upstreams: []config.UpstreamConfig{{Name: "router", Address: lanSrv.URL, Protocol: "https"}},
		},
	}
	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	query := func(name string) *dns.Msg {
		req := new(dns.Msg)
		req.SetQuestion(name, dns.TypeA)
		w := &mockResponseWriter{}
		resolver.ServeDNS(w, req)
		return w.written
	}

	// Subdomain of rule domain goes to the rule upstream.
	resp := query("printer.lan.")
	if resp == nil || len(resp.Answer) == 0 {
		t.Fatal("expected answer for printer.lan")
	}
	if a := resp.Answer[0].(*dns.A); !a.A.Equal(net.IPv4(192, 168, 1, 1)) {
		t.Errorf("printer.lan answered %s, want router upstream answer", a.A)
	}
	if len(lanAsked) != 1 || lanAsked[0] != "printer.lan." {
		t.Errorf("lan upstream asked %v, want [printer.lan.]", lanAsked)
	}

	// Second rule domain matches too.
	if resp := query("nas.home.arpa."); resp == nil || len(resp.Answer) == 0 {
		t.Error("expected answer for nas.home.arpa")
	} else if a := resp.Answer[0].(*dns.A); !a.A.Equal(net.IPv4(192, 168, 1, 1)) {
		t.Errorf("nas.home.arpa answered %s, want router upstream answer", a.A)
	}

	// Unmatched domains use the global upstream.
	if resp := query("example.com."); resp == nil || len(resp.Answer) == 0 {
		t.Fatal("expected answer for example.com")
	} else if a := resp.Answer[0].(*dns.A); !a.A.Equal(net.IPv4(192, 0, 2, 1)) {
		t.Errorf("example.com answered %s, want global upstream answer", a.A)
	}
	for _, name := range globalAsked {
		if name == "printer.lan." || name == "nas.home.arpa." {
			t.Errorf("rule domain %s leaked to global upstream", name)
		}
	}
}

func TestForwardingRuleHotReload(t *testing.T) {
	blCfg := config.BlocklistConfig{RefreshInterval: config.Duration{Duration: time.Hour}}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	var globalAsked, lanAsked []string
	globalSrv := newHTTPServer(answeringUpstream(net.IPv4(192, 0, 2, 1), &globalAsked))
	defer globalSrv.Close()
	lanSrv := newHTTPServer(answeringUpstream(net.IPv4(192, 168, 1, 1), &lanAsked))
	defer lanSrv.Close()

	cfg := minimalResolverConfig(globalSrv.URL)
	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	if rule := resolver.forwardingRuleFor("printer.lan"); rule != nil {
		t.Fatal("no rules configured yet")
	}

	cfg.ForwardingRules = []config.ForwardingRule{
		{Name: "lan", Domains: []string{"lan"}, Upstreams: []config.UpstreamConfig{{Address: lanSrv.URL, Protocol: "https"}}},
	}
	resolver.ApplyUpstreamConfig(cfg)
	if rule := resolver.forwardingRuleFor("printer.lan"); rule == nil || rule.name != "lan" {
		t.Error("expected rule after ApplyUpstreamConfig")
	}

	cfg.ForwardingRules = nil
	resolver.ApplyUpstreamConfig(cfg)
	if rule := resolver.forwardingRuleFor("printer.lan"); rule != nil {
		t.Error("expected rules cleared after ApplyUpstreamConfig with none")
	}
}

func TestForwardingRuleForMostSpecific(t *testing.T) {
	blCfg := config.BlocklistConfig{RefreshInterval: config.Duration{Duration: time.Hour}}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	cfg.ForwardingRules = []config.ForwardingRule{
		{Name: "corp", Domains: []string{"corp.example.com"}, Upstreams: []config.UpstreamConfig{{Address: "10.0.0.1:53"}}},
		{Name: "wide", Domains: []string{"example.com"}, Upstreams: []config.UpstreamConfig{{Address: "10.0.0.2:53"}}},
	}
	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	if rule := resolver.forwardingRuleFor("host.corp.example.com"); rule == nil || rule.name != "corp" {
		t.Errorf("host.corp.example.com matched %v, want corp (most specific)", rule)
	}
	if rule := resolver.forwardingRuleFor("www.example.com"); rule == nil || rule.name != "wide" {
		t.Errorf("www.example.com matched %v, want wide", rule)
	}
	if rule := resolver.forwardingRuleFor("other.org"); rule != nil {
		t.Errorf("other.org matched %v, want nil", rule)
	}
}
