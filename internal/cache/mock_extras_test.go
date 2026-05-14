package cache

import (
	"context"
	"testing"
	"time"

	"github.com/miekg/dns"
)

func TestMockCache_SetEntryWithAuthTTL(t *testing.T) {
	m := NewMockCache()
	msg := new(dns.Msg)
	msg.SetQuestion("auth.example.com.", dns.TypeA)
	m.SetEntryWithAuthTTL("dns:auth.example.com:1:1", msg, time.Minute, 5*time.Minute)

	got, ttl, _, authTTL, err := m.GetWithTTL(context.Background(), "dns:auth.example.com:1:1")
	if err != nil {
		t.Fatalf("GetWithTTL: %v", err)
	}
	if got == nil {
		t.Fatal("expected msg from SetEntryWithAuthTTL")
	}
	if ttl <= 0 {
		t.Errorf("expected positive remaining TTL, got %v", ttl)
	}
	if authTTL != 5*time.Minute {
		t.Errorf("authTTL = %v, want 5m", authTTL)
	}

	// Nil msg and zero TTL are rejected silently.
	before := m.EntryCount()
	m.SetEntryWithAuthTTL("nil-msg", nil, time.Minute, time.Minute)
	m.SetEntryWithAuthTTL("zero-ttl", new(dns.Msg), 0, time.Minute)
	if m.EntryCount() != before {
		t.Errorf("expected no new entries for nil/zero, got delta %d", m.EntryCount()-before)
	}
}

func TestMockCache_SetEntryWithStoredAndAuthTTL(t *testing.T) {
	m := NewMockCache()
	msg := new(dns.Msg)
	msg.SetQuestion("stored.example.com.", dns.TypeA)
	m.SetEntryWithStoredAndAuthTTL("dns:stored.example.com:1:1", msg, 30*time.Second, 5*time.Minute, 10*time.Minute)

	got, ttl, storedTTL, authTTL, err := m.GetWithTTL(context.Background(), "dns:stored.example.com:1:1")
	if err != nil {
		t.Fatalf("GetWithTTL: %v", err)
	}
	if got == nil {
		t.Fatal("expected msg from SetEntryWithStoredAndAuthTTL")
	}
	if ttl <= 0 || ttl > 30*time.Second {
		t.Errorf("expected remaining TTL <=30s and >0, got %v", ttl)
	}
	if authTTL != 10*time.Minute {
		t.Errorf("authTTL = %v, want 10m", authTTL)
	}
	if storedTTL != 5*time.Minute {
		t.Errorf("storedTTL = %v, want 5m", storedTTL)
	}

	// Rejected inputs.
	before := m.EntryCount()
	m.SetEntryWithStoredAndAuthTTL("nil-msg", nil, time.Minute, time.Minute, time.Minute)
	m.SetEntryWithStoredAndAuthTTL("zero-remaining", new(dns.Msg), 0, time.Minute, time.Minute)
	if m.EntryCount() != before {
		t.Errorf("expected no new entries for nil/zero, got delta %d", m.EntryCount()-before)
	}
}

func TestMockCache_AddOrphanIndexEntry(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()
	soft := time.Now().Add(-time.Minute)
	m.AddOrphanIndexEntry("dns:orphan.example.com:1:1", soft)

	// Orphan has no entry but appears in expiry candidates.
	cands, err := m.ExpiryCandidates(ctx, time.Now(), 10)
	if err != nil {
		t.Fatalf("ExpiryCandidates: %v", err)
	}
	found := false
	for _, c := range cands {
		if c.Key == "dns:orphan.example.com:1:1" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected orphan key in candidates: %+v", cands)
	}

	// And BatchCandidateChecks reports it as not existing.
	results, err := m.BatchCandidateChecks(ctx, cands, time.Hour, 0)
	if err != nil {
		t.Fatalf("BatchCandidateChecks: %v", err)
	}
	if len(results) != len(cands) {
		t.Fatalf("results length = %d, want %d", len(results), len(cands))
	}
	for _, r := range results {
		if r.Exists {
			t.Errorf("orphan should report Exists=false")
		}
	}
}

func TestMockCache_EvictToCapInjection(t *testing.T) {
	m := NewMockCache()
	m.EvictToCapEvicted = 7
	got, err := m.EvictToCap(context.Background())
	if err != nil {
		t.Fatalf("EvictToCap: %v", err)
	}
	if got != 7 {
		t.Errorf("EvictToCap = %d, want 7", got)
	}
}

func TestMockCache_SetMaxKeys(t *testing.T) {
	m := NewMockCache()
	// No-op; ensure it doesn't panic for various values.
	m.SetMaxKeys(0)
	m.SetMaxKeys(100)
	m.SetMaxKeys(-1)
}

func TestMockCache_GetSweepHitCount(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()
	key := "dns:sweep.example.com:1:1"
	_, _ = m.IncrementSweepHit(ctx, key, time.Hour)
	_, _ = m.IncrementSweepHit(ctx, key, time.Hour)
	n, err := m.GetSweepHitCount(ctx, key)
	if err != nil {
		t.Fatalf("GetSweepHitCount: %v", err)
	}
	if n != 2 {
		t.Errorf("GetSweepHitCount = %d, want 2", n)
	}
}
