package dnsresolver

import (
	"fmt"
	"testing"
	"time"

	"github.com/miekg/dns"
	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/localrecords"
	"github.com/tternquist/beyond-ads-dns/internal/logging"
)

func TestClientRateLimiterAllow(t *testing.T) {
	rl := newClientRateLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		if !rl.Allow("192.168.1.10") {
			t.Fatalf("query %d should be allowed", i+1)
		}
	}
	if rl.Allow("192.168.1.10") {
		t.Error("4th query should be rate limited")
	}
	// Other clients are unaffected.
	if !rl.Allow("192.168.1.11") {
		t.Error("different client should be allowed")
	}
}

func TestClientRateLimiterWindowReset(t *testing.T) {
	rl := newClientRateLimiter(1, 10*time.Millisecond)
	if !rl.Allow("10.0.0.1") {
		t.Fatal("first query should be allowed")
	}
	if rl.Allow("10.0.0.1") {
		t.Fatal("second query in window should be limited")
	}
	time.Sleep(15 * time.Millisecond)
	if !rl.Allow("10.0.0.1") {
		t.Error("query after window expiry should be allowed")
	}
}

func TestClientRateLimiterPrunesExpired(t *testing.T) {
	rl := newClientRateLimiter(1, time.Nanosecond)
	// Push every shard past the prune threshold (threshold is per shard).
	n := rlShardCount * rlPruneThreshold * 5 / 4
	for i := 0; i < n; i++ {
		rl.Allow(fmt.Sprintf("10.%d.%d.%d", i/65536, (i/256)%256, i%256))
	}
	time.Sleep(time.Millisecond)
	// A new window in an oversized shard prunes its expired entries.
	for i := 0; i < rlShardCount*16; i++ {
		rl.Allow(fmt.Sprintf("172.16.%d.%d", i/256, i%256))
	}
	total := 0
	for i := range rl.shards {
		rl.shards[i].mu.Lock()
		total += len(rl.shards[i].counts)
		rl.shards[i].mu.Unlock()
	}
	if total > n/2 {
		t.Errorf("expected expired entries pruned, %d of %d entries remain", total, n)
	}
}

func TestServeDNSRateLimited(t *testing.T) {
	blCfg := config.BlocklistConfig{RefreshInterval: config.Duration{Duration: time.Hour}}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	cfg.RateLimit = config.RateLimitConfig{Enabled: ptr(true), Queries: 2, Window: config.Duration{Duration: time.Minute}}
	cfg.LocalRecords = []config.LocalRecordEntry{{Name: "local.test.example", Type: "A", Value: "192.168.1.100"}}
	localMgr := localrecords.New(cfg.LocalRecords, logging.NewDiscardLogger())
	resolver := buildTestResolver(t, cfg, nil, blMgr, localMgr)

	query := func(remoteIP string) *dns.Msg {
		req := new(dns.Msg)
		req.SetQuestion("local.test.example.", dns.TypeA)
		w := &mockResponseWriter{remoteAddr: remoteIP}
		resolver.ServeDNS(w, req)
		return w.written
	}

	for i := 0; i < 2; i++ {
		if resp := query("192.168.1.50"); resp == nil || resp.Rcode != dns.RcodeSuccess {
			t.Fatalf("query %d should succeed", i+1)
		}
	}
	resp := query("192.168.1.50")
	if resp == nil || resp.Rcode != dns.RcodeRefused {
		t.Errorf("3rd query should be REFUSED, got %v", resp)
	}
	// Different client is unaffected.
	if resp := query("192.168.1.51"); resp == nil || resp.Rcode != dns.RcodeSuccess {
		t.Error("different client should not be rate limited")
	}
}

func TestServeDNSRateLimitDisabledByDefault(t *testing.T) {
	blCfg := config.BlocklistConfig{RefreshInterval: config.Duration{Duration: time.Hour}}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	cfg.LocalRecords = []config.LocalRecordEntry{{Name: "local.test.example", Type: "A", Value: "192.168.1.100"}}
	localMgr := localrecords.New(cfg.LocalRecords, logging.NewDiscardLogger())
	resolver := buildTestResolver(t, cfg, nil, blMgr, localMgr)

	for i := 0; i < 5; i++ {
		req := new(dns.Msg)
		req.SetQuestion("local.test.example.", dns.TypeA)
		w := &mockResponseWriter{remoteAddr: "192.168.1.50"}
		resolver.ServeDNS(w, req)
		if w.written == nil {
			t.Fatalf("query %d wrote no response", i+1)
		}
		if w.written.Rcode != dns.RcodeSuccess {
			t.Fatalf("query %d rcode = %s, want %s", i+1, dns.RcodeToString[w.written.Rcode], dns.RcodeToString[dns.RcodeSuccess])
		}
	}
}

func TestServeDNSLoopbackExemptFromRateLimit(t *testing.T) {
	blCfg := config.BlocklistConfig{RefreshInterval: config.Duration{Duration: time.Hour}}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	cfg.RateLimit = config.RateLimitConfig{Enabled: ptr(true), Queries: 1, Window: config.Duration{Duration: time.Minute}}
	cfg.LocalRecords = []config.LocalRecordEntry{{Name: "local.test.example", Type: "A", Value: "192.168.1.100"}}
	localMgr := localrecords.New(cfg.LocalRecords, logging.NewDiscardLogger())
	resolver := buildTestResolver(t, cfg, nil, blMgr, localMgr)

	for i := 0; i < 5; i++ {
		req := new(dns.Msg)
		req.SetQuestion("local.test.example.", dns.TypeA)
		w := &mockResponseWriter{} // defaults to 127.0.0.1
		resolver.ServeDNS(w, req)
		if w.written == nil || w.written.Rcode != dns.RcodeSuccess {
			t.Fatalf("loopback query %d should never be rate limited", i+1)
		}
	}
}

func TestServeDNSRefusesANY(t *testing.T) {
	blCfg := config.BlocklistConfig{RefreshInterval: config.Duration{Duration: time.Hour}}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	req := new(dns.Msg)
	req.SetQuestion("example.com.", dns.TypeANY)
	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)

	if w.written == nil {
		t.Fatal("expected response")
	}
	if w.written.Rcode != dns.RcodeSuccess || len(w.written.Answer) != 1 {
		t.Fatalf("expected minimal HINFO answer, rcode=%s answers=%d",
			dns.RcodeToString[w.written.Rcode], len(w.written.Answer))
	}
	hinfo, ok := w.written.Answer[0].(*dns.HINFO)
	if !ok || hinfo.Cpu != "RFC8482" {
		t.Errorf("expected RFC8482 HINFO record, got %v", w.written.Answer[0])
	}
}

func TestServeDNSAnyServedFromLocalRecords(t *testing.T) {
	blCfg := config.BlocklistConfig{RefreshInterval: config.Duration{Duration: time.Hour}}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	cfg := minimalResolverConfig("https://invalid.invalid/dns-query")
	cfg.LocalRecords = []config.LocalRecordEntry{{Name: "local.test.example", Type: "A", Value: "192.168.1.100"}}
	localMgr := localrecords.New(cfg.LocalRecords, logging.NewDiscardLogger())
	resolver := buildTestResolver(t, cfg, nil, blMgr, localMgr)

	req := new(dns.Msg)
	req.SetQuestion("local.test.example.", dns.TypeANY)
	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)

	if w.written == nil || len(w.written.Answer) == 0 {
		t.Fatal("expected local record ANY answer")
	}
	if _, ok := w.written.Answer[0].(*dns.A); !ok {
		t.Errorf("expected local A record for ANY query, got %T", w.written.Answer[0])
	}
}
