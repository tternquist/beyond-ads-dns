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
