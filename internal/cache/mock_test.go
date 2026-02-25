package cache

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/miekg/dns"
)

func TestMockCache_ImplementsDNSCache(t *testing.T) {
	var _ DNSCache = (*MockCache)(nil)
}

func TestMockCache_GetSet(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()

	key := "dns:example.com:1:1"
	msg := new(dns.Msg)
	msg.SetQuestion("example.com.", dns.TypeA)
	msg.Answer = []dns.RR{
		&dns.A{
			Hdr: dns.RR_Header{Name: "example.com.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
			A:   []byte{93, 184, 216, 34},
		},
	}

	if err := m.Set(ctx, key, msg, time.Minute); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, ttl, err := m.GetWithTTL(ctx, key)
	if err != nil {
		t.Fatalf("GetWithTTL: %v", err)
	}
	if got == nil {
		t.Fatal("expected message")
	}
	if ttl <= 0 {
		t.Errorf("expected positive TTL, got %v", ttl)
	}
	if m.EntryCount() != 1 {
		t.Errorf("EntryCount = %d, want 1", m.EntryCount())
	}
}

func TestMockCache_GetWithTTL_Miss(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()

	got, ttl, err := m.GetWithTTL(ctx, "nonexistent")
	if err != nil {
		t.Fatalf("GetWithTTL: %v", err)
	}
	if got != nil {
		t.Error("expected nil for miss")
	}
	if ttl != 0 {
		t.Errorf("expected 0 TTL for miss, got %v", ttl)
	}
}

func TestMockCache_GetWithTTL_ErrorInjection(t *testing.T) {
	m := NewMockCache()
	m.SetGetErr(errors.New("injected"))
	ctx := context.Background()

	_, _, err := m.GetWithTTL(ctx, "any")
	if err == nil {
		t.Error("expected error from GetWithTTL")
	}
}

func TestMockCache_SetWithIndex_ErrorInjection(t *testing.T) {
	m := NewMockCache()
	m.SetSetErr(errors.New("injected"))
	ctx := context.Background()
	msg := new(dns.Msg)
	msg.SetQuestion("example.com.", dns.TypeA)

	err := m.SetWithIndex(ctx, "dns:example.com:1:1", msg, time.Minute)
	if err == nil {
		t.Error("expected error from SetWithIndex")
	}
}

func TestMockCache_IncrementHit_GetHitCount(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()
	key := "dns:example.com:1:1"

	n, err := m.IncrementHit(ctx, key, time.Hour)
	if err != nil {
		t.Fatalf("IncrementHit: %v", err)
	}
	if n != 1 {
		t.Errorf("IncrementHit = %d, want 1", n)
	}
	n, err = m.IncrementHit(ctx, key, time.Hour)
	if err != nil {
		t.Fatalf("IncrementHit #2: %v", err)
	}
	if n != 2 {
		t.Errorf("IncrementHit #2 = %d, want 2", n)
	}
	if got := m.GetHitCountForTest(key); got != 2 {
		t.Errorf("GetHitCountForTest = %d, want 2", got)
	}
}

func TestMockCache_TryAcquireReleaseRefresh(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()
	key := "dns:example.com:1:1"

	ok, err := m.TryAcquireRefresh(ctx, key, time.Second)
	if err != nil {
		t.Fatalf("TryAcquireRefresh: %v", err)
	}
	if !ok {
		t.Error("expected true from TryAcquireRefresh")
	}
	ok, _ = m.TryAcquireRefresh(ctx, key, time.Second)
	if ok {
		t.Error("expected false when lock already held")
	}
	m.ReleaseRefresh(ctx, key)
	ok, err = m.TryAcquireRefresh(ctx, key, time.Second)
	if err != nil || !ok {
		t.Errorf("expected true after release, got ok=%v err=%v", ok, err)
	}
}

func TestMockCache_ExpiryCandidates(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()

	m.SetEntry("dns:a.com:1:1", new(dns.Msg), time.Millisecond)
	time.Sleep(5 * time.Millisecond)

	until := time.Now().Add(time.Minute)
	cands, err := m.ExpiryCandidates(ctx, until, 10)
	if err != nil {
		t.Fatalf("ExpiryCandidates: %v", err)
	}
	if len(cands) != 1 {
		t.Errorf("expected 1 candidate, got %d", len(cands))
	}
}

func TestMockCache_ClearCache(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()
	m.SetEntry("dns:example.com:1:1", new(dns.Msg), time.Minute)
	if m.EntryCount() != 1 {
		t.Fatalf("expected 1 entry before clear")
	}
	if err := m.ClearCache(ctx); err != nil {
		t.Fatalf("ClearCache: %v", err)
	}
	if m.EntryCount() != 0 {
		t.Errorf("expected 0 entries after clear, got %d", m.EntryCount())
	}
}

func TestMockCache_GetCacheStats(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()
	m.SetEntry("dns:example.com:1:1", new(dns.Msg), time.Minute)
	_, _, _ = m.GetWithTTL(ctx, "dns:example.com:1:1")

	stats := m.GetCacheStats()
	if stats.Hits != 1 {
		t.Errorf("Hits = %d, want 1", stats.Hits)
	}
	if stats.LRU == nil {
		t.Error("expected LRU stats")
	}
}

func TestMockCache_Get(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()
	msg := new(dns.Msg)
	msg.SetQuestion("example.com.", dns.TypeA)
	m.SetEntry("dns:example.com:1:1", msg, time.Minute)

	got, err := m.Get(ctx, "dns:example.com:1:1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got == nil {
		t.Fatal("expected message")
	}
}

func TestMockCache_SetStaleEntry(t *testing.T) {
	m := NewMockCache()
	msg := new(dns.Msg)
	msg.SetQuestion("stale.example.com.", dns.TypeA)
	m.SetStaleEntry("dns:stale.example.com:1:1", msg)

	got, ttl, err := m.GetWithTTL(context.Background(), "dns:stale.example.com:1:1")
	if err != nil {
		t.Fatalf("GetWithTTL: %v", err)
	}
	if got == nil {
		t.Fatal("expected message for stale entry")
	}
	if ttl != 0 {
		t.Errorf("expected 0 TTL for stale entry, got %v", ttl)
	}
}

func TestMockCache_IncrementSweepHit_GetSweepHitCount(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()
	key := "dns:example.com:1:1"

	n, err := m.IncrementSweepHit(ctx, key, time.Hour)
	if err != nil {
		t.Fatalf("IncrementSweepHit: %v", err)
	}
	if n != 1 {
		t.Errorf("IncrementSweepHit = %d, want 1", n)
	}
	n, err = m.IncrementSweepHit(ctx, key, time.Hour)
	if err != nil {
		t.Fatalf("IncrementSweepHit #2: %v", err)
	}
	if n != 2 {
		t.Errorf("IncrementSweepHit #2 = %d, want 2", n)
	}
	if got := m.GetSweepHitCountForTest(key); got != 2 {
		t.Errorf("GetSweepHitCountForTest = %d, want 2", got)
	}
}

func TestMockCache_GetHitCount(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()
	key := "dns:example.com:1:1"
	m.IncrementHit(ctx, key, time.Hour)
	m.IncrementHit(ctx, key, time.Hour)

	n, err := m.GetHitCount(ctx, key)
	if err != nil {
		t.Fatalf("GetHitCount: %v", err)
	}
	if n != 2 {
		t.Errorf("GetHitCount = %d, want 2", n)
	}
}

func TestMockCache_FlushHitBatcher(t *testing.T) {
	m := NewMockCache()
	m.FlushHitBatcher() // no-op, should not panic
}

func TestMockCache_Exists(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()
	m.SetEntry("dns:example.com:1:1", new(dns.Msg), time.Minute)

	exists, err := m.Exists(ctx, "dns:example.com:1:1")
	if err != nil {
		t.Fatalf("Exists: %v", err)
	}
	if !exists {
		t.Error("expected exists true for cached key")
	}
	exists, err = m.Exists(ctx, "dns:nonexistent.example.com:1:1")
	if err != nil {
		t.Fatalf("Exists: %v", err)
	}
	if exists {
		t.Error("expected exists false for non-cached key")
	}
}

func TestMockCache_RemoveFromIndex(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()
	m.SetEntry("dns:example.com:1:1", new(dns.Msg), time.Minute)

	m.RemoveFromIndex(ctx, "dns:example.com:1:1")
	cands, _ := m.ExpiryCandidates(ctx, time.Now().Add(time.Hour), 10)
	if len(cands) != 0 {
		t.Errorf("expected 0 candidates after RemoveFromIndex, got %d", len(cands))
	}
}

func TestMockCache_DeleteCacheKey(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()
	m.SetEntry("dns:example.com:1:1", new(dns.Msg), time.Minute)

	m.DeleteCacheKey(ctx, "dns:example.com:1:1")
	if m.EntryCount() != 0 {
		t.Errorf("expected 0 entries after DeleteCacheKey, got %d", m.EntryCount())
	}
}

func TestMockCache_BatchCandidateChecks(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()
	m.SetEntry("dns:a.com:1:1", new(dns.Msg), time.Minute)

	cands := []ExpiryCandidate{
		{Key: "dns:a.com:1:1", SoftExpiry: time.Now()},
		{Key: "dns:b.com:1:1", SoftExpiry: time.Now()},
	}
	results, err := m.BatchCandidateChecks(ctx, cands, time.Hour)
	if err != nil {
		t.Fatalf("BatchCandidateChecks: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if !results[0].Exists {
		t.Error("expected a.com to exist")
	}
	if results[1].Exists {
		t.Error("expected b.com to not exist")
	}
	// SetEntry sets createdAt to now, so first result should have non-zero CreatedAt
	if results[0].CreatedAt.IsZero() {
		t.Error("expected a.com to have non-zero CreatedAt from SetEntry")
	}
}

func TestMockCache_BatchCandidateChecks_CreatedAt(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()
	createdAt := time.Now().Add(-1 * time.Hour)
	// softExpiry will be in the past so ExpiryCandidates returns this key
	m.SetEntryWithCreatedAt("dns:within.example.com:1:1", new(dns.Msg), time.Minute, createdAt)

	cands, err := m.ExpiryCandidates(ctx, time.Now().Add(time.Hour), 10)
	if err != nil || len(cands) != 1 {
		t.Fatalf("ExpiryCandidates: err=%v len=%d", err, len(cands))
	}
	results, err := m.BatchCandidateChecks(ctx, cands, time.Hour)
	if err != nil {
		t.Fatalf("BatchCandidateChecks: %v", err)
	}
	if len(results) != 1 || !results[0].Exists {
		t.Fatalf("expected one existing result, got %d", len(results))
	}
	if results[0].CreatedAt.IsZero() {
		t.Fatal("expected CreatedAt to be set from SetEntryWithCreatedAt")
	}
	if results[0].CreatedAt.Sub(createdAt).Abs() > time.Second {
		t.Errorf("CreatedAt mismatch: got %v, want ~%v", results[0].CreatedAt, createdAt)
	}
}

func TestMockCache_ReconcileExpiryIndex(t *testing.T) {
	m := NewMockCache()
	ctx := context.Background()
	removed, err := m.ReconcileExpiryIndex(ctx, 10)
	if err != nil {
		t.Fatalf("ReconcileExpiryIndex: %v", err)
	}
	if removed != 0 {
		t.Errorf("expected 0 removed, got %d", removed)
	}
}

func TestMockCache_ReleaseMsg(t *testing.T) {
	m := NewMockCache()
	m.ReleaseMsg(nil)   // safe with nil
	m.ReleaseMsg(new(dns.Msg)) // no-op
}

func TestMockCache_CleanLRUCache(t *testing.T) {
	m := NewMockCache()
	m.SetEntry("dns:expired.com:1:1", new(dns.Msg), time.Millisecond)
	time.Sleep(5 * time.Millisecond)

	removed := m.CleanLRUCache()
	if removed != 1 {
		t.Errorf("CleanLRUCache removed = %d, want 1", removed)
	}
	if m.EntryCount() != 0 {
		t.Errorf("expected 0 entries after CleanLRUCache, got %d", m.EntryCount())
	}
}

func TestMockCache_Close(t *testing.T) {
	m := NewMockCache()
	if err := m.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
}
