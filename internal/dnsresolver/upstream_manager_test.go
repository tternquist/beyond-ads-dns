package dnsresolver

import (
	"sync"
	"testing"
	"time"
)

func makeUpstreams(addrs ...string) []Upstream {
	ups := make([]Upstream, len(addrs))
	for i, a := range addrs {
		ups[i] = Upstream{Name: a, Address: a, Protocol: "udp"}
	}
	return ups
}

// --- newUpstreamManager ---

func TestNewUpstreamManager_Failover_NoWeightedLatency(t *testing.T) {
	m := newUpstreamManager(makeUpstreams("8.8.8.8:53"), StrategyFailover, 5*time.Second, 0, 0, false)
	if m.strategy != StrategyFailover {
		t.Errorf("expected failover, got %q", m.strategy)
	}
	if len(m.weightedLatency) != 0 {
		t.Errorf("expected no weighted latency for failover, got %v", m.weightedLatency)
	}
}

func TestNewUpstreamManager_Weighted_InitializesLatency(t *testing.T) {
	ups := makeUpstreams("8.8.8.8:53", "1.1.1.1:53")
	m := newUpstreamManager(ups, StrategyWeighted, 5*time.Second, 0, 0, false)
	for _, u := range ups {
		ptr, ok := m.weightedLatency[u.Address]
		if !ok || ptr == nil {
			t.Errorf("expected weighted latency initialized for %s", u.Address)
		}
		if *ptr != 50.0 {
			t.Errorf("expected initial latency 50ms for %s, got %f", u.Address, *ptr)
		}
	}
}

// --- Upstreams ---

func TestUpstreamManager_Upstreams_ReturnsCopy(t *testing.T) {
	ups := makeUpstreams("8.8.8.8:53", "1.1.1.1:53")
	m := newUpstreamManager(ups, StrategyFailover, 5*time.Second, 0, 0, false)
	got, strat := m.Upstreams()
	if len(got) != 2 {
		t.Errorf("expected 2 upstreams, got %d", len(got))
	}
	if strat != StrategyFailover {
		t.Errorf("expected failover strategy, got %q", strat)
	}
	// Modifying the returned slice should not affect the manager
	got[0].Address = "mutated"
	internal, _ := m.Upstreams()
	if internal[0].Address == "mutated" {
		t.Error("expected Upstreams() to return an independent copy")
	}
}

// --- GetTimeout ---

func TestUpstreamManager_GetTimeout_UsesConfigured(t *testing.T) {
	m := newUpstreamManager(nil, StrategyFailover, 3*time.Second, 0, 0, false)
	if got := m.GetTimeout(); got != 3*time.Second {
		t.Errorf("expected 3s, got %v", got)
	}
}

func TestUpstreamManager_GetTimeout_FallsBackToDefault(t *testing.T) {
	m := newUpstreamManager(nil, StrategyFailover, 0, 0, 0, false)
	if got := m.GetTimeout(); got != defaultUpstreamTimeout {
		t.Errorf("expected default timeout %v, got %v", defaultUpstreamTimeout, got)
	}
}

// --- Order ---

func TestUpstreamManager_Order_Failover_Sequential(t *testing.T) {
	ups := makeUpstreams("a", "b", "c")
	m := newUpstreamManager(ups, StrategyFailover, 5*time.Second, 0, 0, false)
	order := m.Order(ups)
	for i, idx := range order {
		if idx != i {
			t.Errorf("failover order[%d] = %d, expected %d", i, idx, i)
		}
	}
}

func TestUpstreamManager_Order_LoadBalance_RoundRobin(t *testing.T) {
	ups := makeUpstreams("a", "b", "c")
	m := newUpstreamManager(ups, StrategyLoadBalance, 5*time.Second, 0, 0, false)

	// Collect starting indices over several calls
	starts := make(map[int]int)
	for i := 0; i < 30; i++ {
		order := m.Order(ups)
		if len(order) != 3 {
			t.Fatalf("expected 3-element order, got %d", len(order))
		}
		starts[order[0]]++
	}
	// Each upstream should have been first roughly 10 times; any being 0 is suspicious
	for idx := 0; idx < 3; idx++ {
		if starts[idx] == 0 {
			t.Errorf("upstream %d was never first in round-robin over 30 calls", idx)
		}
	}
}

func TestUpstreamManager_Order_LoadBalance_EmptyUpstreams(t *testing.T) {
	m := newUpstreamManager(nil, StrategyLoadBalance, 5*time.Second, 0, 0, false)
	order := m.Order(nil)
	if order != nil {
		t.Errorf("expected nil order for empty upstreams, got %v", order)
	}
}

func TestUpstreamManager_Order_Weighted_PrefersLowerLatency(t *testing.T) {
	ups := makeUpstreams("slow", "fast")
	m := newUpstreamManager(ups, StrategyWeighted, 5*time.Second, 0, 0, false)

	// Set slow to 200ms, fast to 10ms
	m.UpdateWeightedLatency("slow", 200*time.Millisecond)
	for i := 0; i < 5; i++ {
		m.UpdateWeightedLatency("fast", 10*time.Millisecond)
	}

	order := m.Order(ups)
	// "fast" (index 1) should come first
	if order[0] != 1 {
		t.Errorf("expected fast upstream (index 1) first, got order %v", order)
	}
}

// --- UpdateWeightedLatency ---

func TestUpstreamManager_UpdateWeightedLatency_ConvergesOverTime(t *testing.T) {
	ups := makeUpstreams("8.8.8.8:53")
	m := newUpstreamManager(ups, StrategyWeighted, 5*time.Second, 0, 0, false)

	// Drive the EWMA toward 100ms with many samples
	for i := 0; i < 50; i++ {
		m.UpdateWeightedLatency("8.8.8.8:53", 100*time.Millisecond)
	}
	ptr := m.weightedLatency["8.8.8.8:53"]
	if ptr == nil {
		t.Fatal("expected latency pointer to exist")
	}
	// After many iterations the EWMA should be within 1ms of 100ms
	if *ptr < 99.0 || *ptr > 101.0 {
		t.Errorf("expected EWMA ≈100ms after 50 samples, got %.2fms", *ptr)
	}
}

func TestUpstreamManager_UpdateWeightedLatency_ClampsToMinimum(t *testing.T) {
	ups := makeUpstreams("8.8.8.8:53")
	m := newUpstreamManager(ups, StrategyWeighted, 5*time.Second, 0, 0, false)
	m.UpdateWeightedLatency("8.8.8.8:53", 0)
	ptr := m.weightedLatency["8.8.8.8:53"]
	if ptr != nil && *ptr < weightedMinLatencyMS {
		t.Errorf("expected latency >= %v, got %v", weightedMinLatencyMS, *ptr)
	}
}

// --- Backoff ---

func TestUpstreamManager_Backoff_NotInBackoffInitially(t *testing.T) {
	m := newUpstreamManager(nil, StrategyFailover, 5*time.Second, time.Second, 0, false)
	if m.IsInBackoff("8.8.8.8:53") {
		t.Error("expected upstream not in backoff initially")
	}
}

func TestUpstreamManager_Backoff_RecordAndCheck(t *testing.T) {
	m := newUpstreamManager(nil, StrategyFailover, 5*time.Second, time.Minute, 0, false)
	m.RecordBackoff("8.8.8.8:53")
	if !m.IsInBackoff("8.8.8.8:53") {
		t.Error("expected upstream to be in backoff after RecordBackoff")
	}
}

func TestUpstreamManager_Backoff_ClearRemovesBackoff(t *testing.T) {
	m := newUpstreamManager(nil, StrategyFailover, 5*time.Second, time.Minute, 0, false)
	m.RecordBackoff("8.8.8.8:53")
	m.ClearBackoff("8.8.8.8:53")
	if m.IsInBackoff("8.8.8.8:53") {
		t.Error("expected backoff cleared after ClearBackoff")
	}
}

func TestUpstreamManager_Backoff_DisabledWhenZero(t *testing.T) {
	// backoff duration = 0 means disabled
	m := newUpstreamManager(nil, StrategyFailover, 5*time.Second, 0, 0, false)
	m.RecordBackoff("8.8.8.8:53")
	if m.IsInBackoff("8.8.8.8:53") {
		t.Error("expected backoff to be disabled when backoff duration is 0")
	}
}

func TestUpstreamManager_BackoffEnabled(t *testing.T) {
	m1 := newUpstreamManager(nil, StrategyFailover, 5*time.Second, time.Second, 0, false)
	if !m1.BackoffEnabled() {
		t.Error("expected BackoffEnabled() = true when backoff > 0")
	}

	m2 := newUpstreamManager(nil, StrategyFailover, 5*time.Second, 0, 0, false)
	if m2.BackoffEnabled() {
		t.Error("expected BackoffEnabled() = false when backoff = 0")
	}
}

// --- Strategy ---

func TestUpstreamManager_Strategy(t *testing.T) {
	for _, strat := range []string{StrategyFailover, StrategyLoadBalance, StrategyWeighted} {
		m := newUpstreamManager(nil, strat, 5*time.Second, 0, 0, false)
		if got := m.Strategy(); got != strat {
			t.Errorf("expected %q, got %q", strat, got)
		}
	}
}

// --- GetConnPoolConfig ---

func TestUpstreamManager_GetConnPoolConfig(t *testing.T) {
	m := newUpstreamManager(nil, StrategyFailover, 5*time.Second, 0, 30*time.Second, true)
	idle, validate := m.GetConnPoolConfig()
	if idle != 30*time.Second {
		t.Errorf("expected 30s idle timeout, got %v", idle)
	}
	if !validate {
		t.Error("expected validateBeforeReuse = true")
	}
}

// --- ApplyConfig ---

func TestUpstreamManager_ApplyConfig_UpdatesUpstreams(t *testing.T) {
	ups := makeUpstreams("a", "b")
	m := newUpstreamManager(ups, StrategyFailover, 5*time.Second, 0, 0, false)

	newUps := makeUpstreams("c", "d", "e")
	m.ApplyConfig(newUps, StrategyLoadBalance, 10*time.Second, 0, 0, false)

	got, strat := m.Upstreams()
	if len(got) != 3 {
		t.Errorf("expected 3 upstreams after ApplyConfig, got %d", len(got))
	}
	if strat != StrategyLoadBalance {
		t.Errorf("expected load_balance strategy after ApplyConfig, got %q", strat)
	}
	if m.GetTimeout() != 10*time.Second {
		t.Errorf("expected 10s timeout after ApplyConfig, got %v", m.GetTimeout())
	}
}

func TestUpstreamManager_ApplyConfig_ClearsBackoffForRemovedUpstreams(t *testing.T) {
	ups := makeUpstreams("a", "b")
	m := newUpstreamManager(ups, StrategyFailover, 5*time.Second, time.Minute, 0, false)
	m.RecordBackoff("a")
	m.RecordBackoff("b")

	// Remove "a" from the config
	m.ApplyConfig(makeUpstreams("b"), StrategyFailover, 5*time.Second, time.Minute, 0, false)

	if m.IsInBackoff("a") {
		t.Error("expected backoff for removed upstream 'a' to be cleared")
	}
	if !m.IsInBackoff("b") {
		t.Error("expected backoff for retained upstream 'b' to remain")
	}
}

func TestUpstreamManager_ApplyConfig_WeightedPreservesExistingLatency(t *testing.T) {
	ups := makeUpstreams("8.8.8.8:53", "1.1.1.1:53")
	m := newUpstreamManager(ups, StrategyWeighted, 5*time.Second, 0, 0, false)

	// Set a known latency for 8.8.8.8:53
	for i := 0; i < 10; i++ {
		m.UpdateWeightedLatency("8.8.8.8:53", 200*time.Millisecond)
	}
	before := *m.weightedLatency["8.8.8.8:53"]

	// ApplyConfig with same upstream still present
	m.ApplyConfig(ups, StrategyWeighted, 5*time.Second, 0, 0, false)

	if *m.weightedLatency["8.8.8.8:53"] != before {
		t.Errorf("expected latency preserved for existing upstream, got %.2f (was %.2f)",
			*m.weightedLatency["8.8.8.8:53"], before)
	}
}

func TestUpstreamManager_ApplyConfig_WeightedInitializesNewUpstreams(t *testing.T) {
	ups := makeUpstreams("a")
	m := newUpstreamManager(ups, StrategyWeighted, 5*time.Second, 0, 0, false)

	// Add a new upstream via ApplyConfig
	m.ApplyConfig(makeUpstreams("a", "b"), StrategyWeighted, 5*time.Second, 0, 0, false)

	ptr := m.weightedLatency["b"]
	if ptr == nil {
		t.Fatal("expected new upstream 'b' to have latency initialized")
	}
	if *ptr != 50.0 {
		t.Errorf("expected new upstream initial latency 50ms, got %.2f", *ptr)
	}
}

// --- Concurrency ---

func TestUpstreamManager_ConcurrentAccess(t *testing.T) {
	ups := makeUpstreams("8.8.8.8:53", "1.1.1.1:53")
	m := newUpstreamManager(ups, StrategyWeighted, 5*time.Second, time.Second, 0, false)

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			switch n % 5 {
			case 0:
				m.Order(ups)
			case 1:
				m.UpdateWeightedLatency("8.8.8.8:53", time.Duration(n)*time.Millisecond)
			case 2:
				m.RecordBackoff("8.8.8.8:53")
			case 3:
				m.IsInBackoff("8.8.8.8:53")
			case 4:
				m.ApplyConfig(ups, StrategyWeighted, 5*time.Second, time.Second, 0, false)
			}
		}(i)
	}
	wg.Wait()
}
