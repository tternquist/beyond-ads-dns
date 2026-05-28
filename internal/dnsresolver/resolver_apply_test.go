package dnsresolver

import (
	"context"
	"testing"
	"time"

	"github.com/miekg/dns"
	"github.com/tternquist/beyond-ads-dns/internal/cache"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/querystore"
	"github.com/tternquist/beyond-ads-dns/internal/tracelog"
)

func boolPtr(b bool) *bool { return &b }

// fakeQueryStore is a minimal querystore.Store for QueryStoreStats wiring.
type fakeQueryStore struct{ stats querystore.StoreStats }

func (f *fakeQueryStore) Record(querystore.Event)      {}
func (f *fakeQueryStore) Close() error                 { return nil }
func (f *fakeQueryStore) Stats() querystore.StoreStats { return f.stats }

func TestApplyUpstreamConfig(t *testing.T) {
	r := buildTestResolverInternal(config.Config{}, nil, nil, nil)

	cfg := config.Config{
		ResolverStrategy: "load_balance",
		Upstreams: []config.UpstreamConfig{
			{Name: "a", Address: "1.1.1.1:53", Protocol: "udp"},
			{Name: "b", Address: "8.8.8.8:53", Protocol: "udp"},
		},
	}
	r.ApplyUpstreamConfig(cfg)

	ups, strategy := r.UpstreamConfig()
	if len(ups) != 2 {
		t.Fatalf("UpstreamConfig got %d upstreams, want 2", len(ups))
	}
	if strategy != StrategyLoadBalance {
		t.Errorf("strategy = %q, want %q", strategy, StrategyLoadBalance)
	}
}

func TestApplyUpstreamConfig_InvalidStrategyFallsBackToFailover(t *testing.T) {
	r := buildTestResolverInternal(config.Config{}, nil, nil, nil)
	r.ApplyUpstreamConfig(config.Config{
		ResolverStrategy: "nonsense",
		Upstreams:        []config.UpstreamConfig{{Name: "a", Address: "1.1.1.1:53", Protocol: "udp"}},
	})
	if _, strategy := r.UpstreamConfig(); strategy != StrategyFailover {
		t.Errorf("strategy = %q, want fallback %q", strategy, StrategyFailover)
	}
}

func TestApplySafeSearchConfig(t *testing.T) {
	r := buildTestResolverInternal(config.Config{}, nil, nil, nil)

	r.ApplySafeSearchConfig(config.Config{
		SafeSearch: config.SafeSearchConfig{Enabled: boolPtr(true), Google: boolPtr(true), Bing: boolPtr(true)},
	})

	r.safeSearchMu.RLock()
	target, ok := r.safeSearchMap["www.google.com"]
	r.safeSearchMu.RUnlock()
	if !ok || target != "forcesafesearch.google.com" {
		t.Errorf("safeSearchMap[www.google.com] = %q (ok=%v), want forcesafesearch.google.com", target, ok)
	}

	// Disabling clears the map.
	r.ApplySafeSearchConfig(config.Config{
		SafeSearch: config.SafeSearchConfig{Enabled: boolPtr(false)},
	})
	r.safeSearchMu.RLock()
	n := len(r.safeSearchMap)
	r.safeSearchMu.RUnlock()
	if n != 0 {
		t.Errorf("safeSearchMap size after disable = %d, want 0", n)
	}
}

func TestApplyResponseConfig(t *testing.T) {
	r := buildTestResolverInternal(config.Config{}, nil, nil, nil)

	r.ApplyResponseConfig(config.Config{
		Response: config.ResponseConfig{Blocked: "0.0.0.0", BlockedTTL: config.Duration{Duration: 30 * time.Second}},
	})
	r.responseMu.RLock()
	gotResp, gotTTL := r.blockedResponse, r.blockedTTL
	r.responseMu.RUnlock()
	if gotResp != "0.0.0.0" || gotTTL != 30*time.Second {
		t.Errorf("blockedResponse=%q ttl=%v, want 0.0.0.0/30s", gotResp, gotTTL)
	}

	// Empty values fall back to defaults (nxdomain, 1h).
	r.ApplyResponseConfig(config.Config{})
	r.responseMu.RLock()
	gotResp, gotTTL = r.blockedResponse, r.blockedTTL
	r.responseMu.RUnlock()
	if gotResp != "nxdomain" || gotTTL != time.Hour {
		t.Errorf("defaults: blockedResponse=%q ttl=%v, want nxdomain/1h", gotResp, gotTTL)
	}
}

func TestApplyCacheMaxKeys(t *testing.T) {
	mc := cache.NewMockCache()
	r := buildTestResolverInternal(config.Config{}, mc, nil, nil)
	// MockCache implements CacheWithConfig; this should not panic and is a no-op assertion.
	r.ApplyCacheMaxKeys(123)

	// With a nil cache it must be a safe no-op.
	rNil := buildTestResolverInternal(config.Config{}, nil, nil, nil)
	rNil.ApplyCacheMaxKeys(5)
}

func TestQueryStoreStats(t *testing.T) {
	fqs := &fakeQueryStore{stats: querystore.StoreStats{BufferSize: 10, TotalRecorded: 7}}
	r := buildTestResolverWithQueryStore(config.Config{}, nil, nil, nil, fqs)
	got := r.QueryStoreStats()
	if got.BufferSize != 10 || got.TotalRecorded != 7 {
		t.Errorf("QueryStoreStats = %+v, want BufferSize=10 TotalRecorded=7", got)
	}

	// Nil query store yields a zero-value struct.
	rNil := buildTestResolverInternal(config.Config{}, nil, nil, nil)
	if (rNil.QueryStoreStats() != querystore.StoreStats{}) {
		t.Error("QueryStoreStats with nil store should be zero value")
	}
}

func TestSetTraceEvents(t *testing.T) {
	r := buildTestResolverInternal(config.Config{}, nil, nil, nil)
	ev := tracelog.New([]string{"example.com"})
	r.SetTraceEvents(ev)
	if got := r.traceEvents.Load(); got != ev {
		t.Errorf("traceEvents.Load() = %v, want the events we stored", got)
	}
}

func TestServfailReply(t *testing.T) {
	r := buildTestResolverInternal(config.Config{}, nil, nil, nil)
	req := new(dns.Msg)
	req.SetQuestion("example.com.", dns.TypeA)
	resp := r.servfailReply(req)
	if resp.Rcode != dns.RcodeServerFailure {
		t.Errorf("servfailReply rcode = %d, want SERVFAIL (%d)", resp.Rcode, dns.RcodeServerFailure)
	}
	if resp.Id != req.Id {
		t.Errorf("servfailReply id = %d, want %d (matched to request)", resp.Id, req.Id)
	}
}

func TestSafeSearchReply(t *testing.T) {
	r := buildTestResolverInternal(config.Config{}, nil, nil, nil)
	req := new(dns.Msg)
	q := dns.Question{Name: "www.google.com.", Qtype: dns.TypeA, Qclass: dns.ClassINET}
	req.Question = []dns.Question{q}

	resp := r.safeSearchReply(req, q, "forcesafesearch.google.com")
	if len(resp.Answer) != 1 {
		t.Fatalf("safeSearchReply answers = %d, want 1", len(resp.Answer))
	}
	cname, ok := resp.Answer[0].(*dns.CNAME)
	if !ok {
		t.Fatalf("answer type = %T, want *dns.CNAME", resp.Answer[0])
	}
	if cname.Target != "forcesafesearch.google.com." {
		t.Errorf("CNAME target = %q, want forcesafesearch.google.com.", cname.Target)
	}
	if cname.Hdr.Name != "www.google.com." {
		t.Errorf("CNAME name = %q, want www.google.com.", cname.Hdr.Name)
	}
}

func TestApplyBlocklistConfig_GroupManagers(t *testing.T) {
	r := buildTestResolverInternal(config.Config{}, nil, nil, nil)
	ctx := context.Background()

	cfg := config.Config{
		Blocklists: config.BlocklistConfig{RefreshInterval: config.Duration{Duration: time.Hour}},
		ClientGroups: []config.ClientGroup{
			{
				ID: "kids",
				Blocklist: &config.GroupBlocklistConfig{
					InheritGlobal: boolPtr(false),
					Denylist:      []string{"ads.example.com"},
				},
			},
		},
	}
	r.ApplyBlocklistConfig(ctx, cfg)

	r.groupBlocklistsMu.RLock()
	mgr, ok := r.groupBlocklists["kids"]
	r.groupBlocklistsMu.RUnlock()
	if !ok || mgr == nil {
		t.Fatal("expected a group blocklist manager for group 'kids'")
	}

	// Re-applying with no groups clears the managers.
	r.ApplyBlocklistConfig(ctx, config.Config{
		Blocklists: config.BlocklistConfig{RefreshInterval: config.Duration{Duration: time.Hour}},
	})
	r.groupBlocklistsMu.RLock()
	n := len(r.groupBlocklists)
	r.groupBlocklistsMu.RUnlock()
	if n != 0 {
		t.Errorf("group blocklists after clearing = %d, want 0", n)
	}
}
