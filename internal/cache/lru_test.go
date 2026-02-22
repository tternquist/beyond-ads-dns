package cache

import (
	"fmt"
	"log/slog"
	"testing"
	"time"

	"github.com/miekg/dns"
)

func TestLRUCache_Basic(t *testing.T) {
	cache := NewLRUCache(3, nil, 0)

	msg1 := &dns.Msg{}
	msg1.SetQuestion("example.com.", dns.TypeA)
	msg1.Answer = []dns.RR{&dns.A{
		Hdr: dns.RR_Header{Name: "example.com.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 300},
		A:   []byte{192, 0, 2, 1},
	}}

	// Test Set and Get
	cache.Set("dns:example.com:1:1", msg1, 5*time.Second)
	retrieved, ttl, ok := cache.Get("dns:example.com:1:1")
	if !ok {
		t.Fatal("expected cache hit")
	}
	if retrieved == nil {
		t.Fatal("expected non-nil message")
	}
	if ttl <= 0 {
		t.Fatal("expected positive TTL")
	}
	if ttl > 5*time.Second {
		t.Fatalf("TTL too high: %v", ttl)
	}

	// Verify it's a copy, not the same pointer
	if retrieved == msg1 {
		t.Error("expected a copy of the message, not the same pointer")
	}
}

// TestLRUCache_GetReturnsIndependentCopy verifies the Get contract: mutating the
// returned message does not affect the cached entry (N6 architecture review).
func TestLRUCache_GetReturnsIndependentCopy(t *testing.T) {
	cache := NewLRUCache(10, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)
	msg.Id = 12345
	msg.Answer = []dns.RR{&dns.A{
		Hdr: dns.RR_Header{Name: "example.com.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 300},
		A:   []byte{192, 0, 2, 1},
	}}

	cache.Set("key1", msg, 10*time.Second)

	// Get and mutate
	retrieved, _, ok := cache.Get("key1")
	if !ok {
		t.Fatal("expected cache hit")
	}
	retrieved.Id = 9999
	retrieved.Question[0].Name = "mutated.com."
	if len(retrieved.Answer) > 0 {
		retrieved.Answer[0].Header().Ttl = 1
	}

	// Get again — cached entry must be unchanged
	retrieved2, _, ok2 := cache.Get("key1")
	if !ok2 {
		t.Fatal("expected cache hit on second Get")
	}
	if retrieved2.Id != 12345 {
		t.Errorf("cached entry corrupted: Id=%d, want 12345", retrieved2.Id)
	}
	if retrieved2.Question[0].Name != "example.com." {
		t.Errorf("cached entry corrupted: Question=%s, want example.com.", retrieved2.Question[0].Name)
	}
	if len(retrieved2.Answer) > 0 && retrieved2.Answer[0].Header().Ttl != 300 {
		t.Errorf("cached entry corrupted: TTL=%d, want 300", retrieved2.Answer[0].Header().Ttl)
	}
}

func TestLRUCache_Expiry(t *testing.T) {
	cache := NewLRUCache(10, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	// Add with very short TTL
	cache.Set("key1", msg, 50*time.Millisecond)

	// Should be accessible immediately
	_, _, ok := cache.Get("key1")
	if !ok {
		t.Fatal("expected cache hit immediately after set")
	}

	// Wait for soft expiry
	time.Sleep(100 * time.Millisecond)

	// Should still exist but with 0 remaining TTL
	retrieved, ttl, ok := cache.Get("key1")
	if !ok {
		// Depending on grace period, this might be expired
		t.Log("entry expired after soft TTL")
		return
	}
	if ttl > 0 {
		t.Errorf("expected 0 TTL after soft expiry, got %v", ttl)
	}
	if retrieved == nil {
		t.Error("expected non-nil message")
	}
}

func TestLRUCache_Eviction(t *testing.T) {
	cache := NewLRUCache(3, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	// Fill cache
	cache.Set("key1", msg, 10*time.Second)
	cache.Set("key2", msg, 10*time.Second)
	cache.Set("key3", msg, 10*time.Second)

	if cache.Len() != 3 {
		t.Fatalf("expected 3 entries, got %d", cache.Len())
	}

	// Add one more - should evict oldest (key1)
	cache.Set("key4", msg, 10*time.Second)

	if cache.Len() != 3 {
		t.Fatalf("expected 3 entries after eviction, got %d", cache.Len())
	}

	// key1 should be evicted
	_, _, ok := cache.Get("key1")
	if ok {
		t.Error("expected key1 to be evicted")
	}

	// key2, key3, key4 should exist
	for _, key := range []string{"key2", "key3", "key4"} {
		_, _, ok := cache.Get(key)
		if !ok {
			t.Errorf("expected %s to exist", key)
		}
	}
}

func TestLRUCache_EvictionOrder(t *testing.T) {
	cache := NewLRUCache(3, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	// Add 3 entries
	cache.Set("key1", msg, 10*time.Second)
	cache.Set("key2", msg, 10*time.Second)
	cache.Set("key3", msg, 10*time.Second)

	// Access key1 (sets visited bit; SIEVE gives it a second chance when hand passes)
	cache.Get("key1")

	// Add key4 - SIEVE evicts one entry (semantics differ from LRU; one of key1/key2/key3 evicted)
	cache.Set("key4", msg, 10*time.Second)

	if cache.Len() != 3 {
		t.Errorf("expected 3 entries after eviction, got %d", cache.Len())
	}

	// key4 (just added) must exist
	_, _, ok := cache.Get("key4")
	if !ok {
		t.Error("expected key4 to exist")
	}

	// Exactly one of key1, key2, key3 was evicted
	exists := 0
	for _, key := range []string{"key1", "key2", "key3"} {
		if _, _, ok := cache.Get(key); ok {
			exists++
		}
	}
	if exists != 2 {
		t.Errorf("expected 2 of key1/key2/key3 to exist, got %d", exists)
	}
}

func TestLRUCache_Update(t *testing.T) {
	cache := NewLRUCache(10, nil, 0)

	msg1 := &dns.Msg{}
	msg1.SetQuestion("example.com.", dns.TypeA)
	msg1.Answer = []dns.RR{&dns.A{
		Hdr: dns.RR_Header{Name: "example.com.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 300},
		A:   []byte{192, 0, 2, 1},
	}}

	msg2 := &dns.Msg{}
	msg2.SetQuestion("example.com.", dns.TypeA)
	msg2.Answer = []dns.RR{&dns.A{
		Hdr: dns.RR_Header{Name: "example.com.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 300},
		A:   []byte{192, 0, 2, 2},
	}}

	// Set initial value
	cache.Set("key1", msg1, 10*time.Second)

	// Update with new value
	cache.Set("key1", msg2, 10*time.Second)

	// Should still have only 1 entry
	if cache.Len() != 1 {
		t.Fatalf("expected 1 entry, got %d", cache.Len())
	}

	// Should retrieve updated value
	retrieved, _, ok := cache.Get("key1")
	if !ok {
		t.Fatal("expected cache hit")
	}
	if len(retrieved.Answer) == 0 {
		t.Fatal("expected answer section")
	}
	a := retrieved.Answer[0].(*dns.A)
	if a.A[3] != 2 {
		t.Error("expected updated value")
	}
}

func TestLRUCache_Delete(t *testing.T) {
	cache := NewLRUCache(10, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	cache.Set("key1", msg, 10*time.Second)
	cache.Set("key2", msg, 10*time.Second)

	// Delete key1
	cache.Delete("key1")

	// key1 should not exist
	_, _, ok := cache.Get("key1")
	if ok {
		t.Error("expected key1 to be deleted")
	}

	// key2 should still exist
	_, _, ok = cache.Get("key2")
	if !ok {
		t.Error("expected key2 to exist")
	}

	// Length should be 1
	if cache.Len() != 1 {
		t.Fatalf("expected 1 entry, got %d", cache.Len())
	}
}

func TestLRUCache_Clear(t *testing.T) {
	cache := NewLRUCache(10, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	cache.Set("key1", msg, 10*time.Second)
	cache.Set("key2", msg, 10*time.Second)
	cache.Set("key3", msg, 10*time.Second)

	cache.Clear()

	if cache.Len() != 0 {
		t.Fatalf("expected 0 entries after clear, got %d", cache.Len())
	}

	_, _, ok := cache.Get("key1")
	if ok {
		t.Error("expected cache to be empty")
	}
}

func TestLRUCache_Stats(t *testing.T) {
	cache := NewLRUCache(10, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	// Add entries with different TTLs
	cache.Set("fresh1", msg, 10*time.Second)
	cache.Set("fresh2", msg, 10*time.Second)
	cache.Set("short", msg, 50*time.Millisecond)

	stats := cache.Stats()
	if stats.Entries != 3 {
		t.Errorf("expected 3 entries, got %d", stats.Entries)
	}
	if stats.MaxEntries != 10 {
		t.Errorf("expected max 10, got %d", stats.MaxEntries)
	}

	// Wait for short entry to expire (soft expiry)
	time.Sleep(100 * time.Millisecond)

	stats = cache.Stats()
	// Depending on timing, short entry might be stale or fresh
	if stats.Fresh+stats.Stale+stats.Expired != 3 {
		t.Errorf("expected total 3 entries, got fresh=%d stale=%d expired=%d",
			stats.Fresh, stats.Stale, stats.Expired)
	}
}

func TestLRUCache_CleanExpired(t *testing.T) {
	cache := NewLRUCache(10, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	// Add entries with different TTLs
	cache.Set("long1", msg, 10*time.Second)
	cache.Set("long2", msg, 10*time.Second)
	cache.Set("short1", msg, 50*time.Millisecond)
	cache.Set("short2", msg, 50*time.Millisecond)

	// Wait for short entries to fully expire (including grace period)
	time.Sleep(200 * time.Millisecond)

	removed := cache.CleanExpired()
	if removed < 2 {
		t.Errorf("expected at least 2 expired entries removed, got %d", removed)
	}

	if cache.Len() > 2 {
		t.Errorf("expected at most 2 entries remaining, got %d", cache.Len())
	}

	// Long entries should still exist
	_, _, ok := cache.Get("long1")
	if !ok {
		t.Error("expected long1 to still exist")
	}
}

func TestLRUCache_Concurrent(t *testing.T) {
	cache := NewLRUCache(100, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	// Test concurrent access
	done := make(chan bool)
	for i := 0; i < 10; i++ {
		go func(id int) {
			for j := 0; j < 100; j++ {
				key := "key-" + string(rune(id*100+j))
				cache.Set(key, msg, time.Second)
				cache.Get(key)
			}
			done <- true
		}(i)
	}

	for i := 0; i < 10; i++ {
		<-done
	}

	// Should not panic and should have entries
	if cache.Len() == 0 {
		t.Error("expected cache to have entries")
	}
}

func TestLRUCache_ZeroTTL(t *testing.T) {
	cache := NewLRUCache(10, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	// Set with 0 TTL should be ignored
	cache.Set("key1", msg, 0)

	_, _, ok := cache.Get("key1")
	if ok {
		t.Error("expected entry with 0 TTL to not be cached")
	}

	if cache.Len() != 0 {
		t.Error("expected cache to be empty")
	}
}

func TestLRUCache_NilMessage(t *testing.T) {
	cache := NewLRUCache(10, nil, 0)

	// Set with nil message should be ignored
	cache.Set("key1", nil, 10*time.Second)

	_, _, ok := cache.Get("key1")
	if ok {
		t.Error("expected nil message to not be cached")
	}

	if cache.Len() != 0 {
		t.Error("expected cache to be empty")
	}
}

func TestShardedLRUCache_Basic(t *testing.T) {
	cache := NewShardedLRUCache(1000, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)
	msg.Answer = []dns.RR{&dns.A{
		Hdr: dns.RR_Header{Name: "example.com.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 300},
		A:   []byte{192, 0, 2, 1},
	}}

	cache.Set("dns:example.com:1:1", msg, 5*time.Second)
	retrieved, ttl, ok := cache.Get("dns:example.com:1:1")
	if !ok {
		t.Fatal("expected cache hit")
	}
	if retrieved == nil || ttl <= 0 {
		t.Fatal("expected non-nil message with positive TTL")
	}
}

func TestShardedLRUCache_Concurrent(t *testing.T) {
	cache := NewShardedLRUCache(10000, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	// Simulate high QPS - many goroutines hitting different keys
	done := make(chan bool)
	for i := 0; i < 64; i++ {
		go func(id int) {
			for j := 0; j < 500; j++ {
				key := fmt.Sprintf("dns:test-%d-%d.com:1:1", id, j)
				cache.Set(key, msg, 10*time.Second)
				cache.Get(key)
			}
			done <- true
		}(i)
	}

	for i := 0; i < 64; i++ {
		<-done
	}

	if cache.Len() == 0 {
		t.Error("expected cache to have entries")
	}
}

// TestShardedLRUCache_SmallConfig validates that small lru_size configs are respected.
// Previously, config 10 would show 3200 max (32 shards × 100 min) instead of 10.
func TestShardedLRUCache_SmallConfig(t *testing.T) {
	cache := NewShardedLRUCache(10, nil, 0)

	stats := cache.Stats()
	if stats.MaxEntries != 10 {
		t.Errorf("expected max 10 for lru_size=10, got %d", stats.MaxEntries)
	}

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	// Fill to capacity
	for i := 0; i < 10; i++ {
		key := fmt.Sprintf("key%d", i)
		cache.Set(key, msg, 10*time.Second)
	}
	if cache.Len() != 10 {
		t.Errorf("expected 10 entries, got %d", cache.Len())
	}

	// Add one more - should evict oldest
	cache.Set("key10", msg, 10*time.Second)
	if cache.Len() != 10 {
		t.Errorf("expected 10 after eviction, got %d", cache.Len())
	}
	_, _, ok := cache.Get("key0")
	if ok {
		t.Error("expected key0 to be evicted")
	}
}

// TestShardedLRUCache_Fill validates eviction when the sharded LRU cache fills.
// With 32 shards and perShard=100, total capacity is 3200. Adding 5000 keys
// triggers eviction; cache should stay at max capacity.
func TestShardedLRUCache_Fill(t *testing.T) {
	cache := NewShardedLRUCache(3200, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	// Fill beyond capacity - 5000 unique keys
	for i := 0; i < 5000; i++ {
		key := fmt.Sprintf("dns:fill-test-%d.example.com:1:1", i)
		cache.Set(key, msg, 10*time.Second)
	}

	stats := cache.Stats()
	if stats.Entries > stats.MaxEntries {
		t.Errorf("cache exceeded max: entries=%d max=%d", stats.Entries, stats.MaxEntries)
	}
	// After fill, cache should be at capacity (some evictions occurred)
	if stats.Entries < 3000 {
		t.Errorf("expected cache near capacity after fill, got %d entries", stats.Entries)
	}

	// Most recently added keys (4000-4999) should likely be present
	// Oldest keys (0-999) may have been evicted
	foundRecent := 0
	for i := 4500; i < 5000; i++ {
		key := fmt.Sprintf("dns:fill-test-%d.example.com:1:1", i)
		if _, _, ok := cache.Get(key); ok {
			foundRecent++
		}
	}
	if foundRecent < 40 {
		t.Errorf("expected most recent keys to be cached, found %d/50", foundRecent)
	}
}

// TestShardedLRUCache_Delete exercises ShardedLRUCache.Delete.
func TestShardedLRUCache_Delete(t *testing.T) {
	cache := NewShardedLRUCache(100, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	cache.Set("key1", msg, 10*time.Second)
	cache.Set("key2", msg, 10*time.Second)

	cache.Delete("key1")

	_, _, ok := cache.Get("key1")
	if ok {
		t.Error("expected key1 to be deleted")
	}
	_, _, ok = cache.Get("key2")
	if !ok {
		t.Error("expected key2 to exist")
	}
}

// TestShardedLRUCache_CleanExpired exercises ShardedLRUCache.CleanExpired.
func TestShardedLRUCache_CleanExpired(t *testing.T) {
	cache := NewShardedLRUCache(100, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	cache.Set("long1", msg, 10*time.Second)
	cache.Set("short1", msg, 50*time.Millisecond)

	time.Sleep(200 * time.Millisecond)

	removed := cache.CleanExpired()
	if removed < 1 {
		t.Errorf("expected at least 1 expired entry removed, got %d", removed)
	}

	_, _, ok := cache.Get("long1")
	if !ok {
		t.Error("expected long1 to still exist")
	}
}

// TestLRUCache_EvictionWithLogger exercises evictOne with a logger (debug log path).
func TestLRUCache_EvictionWithLogger(t *testing.T) {
	logger := slog.Default()
	cache := NewLRUCache(2, logger, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	cache.Set("key1", msg, 10*time.Second)
	cache.Set("key2", msg, 10*time.Second)
	cache.Set("key3", msg, 10*time.Second) // triggers eviction with logging

	if cache.Len() != 2 {
		t.Errorf("expected 2 entries after eviction, got %d", cache.Len())
	}
}

// TestLRUCache_GetExpiredRemoval exercises Get path that removes an expired entry.
func TestLRUCache_GetExpiredRemoval(t *testing.T) {
	cache := NewLRUCache(10, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	cache.Set("expiring", msg, 10*time.Millisecond)
	time.Sleep(50 * time.Millisecond)

	_, _, ok := cache.Get("expiring")
	if ok {
		t.Error("expected expired entry to be removed and return miss")
	}

	if cache.Len() != 0 {
		t.Errorf("expected expired entry to be removed from cache, got %d entries", cache.Len())
	}
}

// TestLRUCache_SIEVE_VisitedPreservesEntry verifies SIEVE semantics: an entry accessed
// after the hand has passed gets a second chance (visited bit prevents eviction).
func TestLRUCache_SIEVE_VisitedPreservesEntry(t *testing.T) {
	cache := NewLRUCache(3, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	cache.Set("key1", msg, 10*time.Second)
	cache.Set("key2", msg, 10*time.Second)
	cache.Set("key3", msg, 10*time.Second)

	// Add key4 - evicts one entry (key1 at tail). Hand advances through key2, key3, key4.
	cache.Set("key4", msg, 10*time.Second)

	// Access key2 - sets visited bit. Hand will have passed key2 during eviction.
	cache.Get("key2")

	// Add key5 - evicts one. key2 has visited=1 so it gets a second chance; key3 or key4 evicted.
	cache.Set("key5", msg, 10*time.Second)

	// key2 (accessed after hand passed) and key5 (just added) must exist
	_, _, ok2 := cache.Get("key2")
	_, _, ok5 := cache.Get("key5")
	if !ok2 {
		t.Error("expected key2 (accessed after hand passed) to be preserved by SIEVE visited bit")
	}
	if !ok5 {
		t.Error("expected key5 to exist")
	}

	// Exactly 3 entries total
	if cache.Len() != 3 {
		t.Errorf("expected 3 entries, got %d", cache.Len())
	}
}

// TestLRUCache_ClearResetsHand verifies Clear resets the SIEVE hand.
func TestLRUCache_ClearResetsHand(t *testing.T) {
	cache := NewLRUCache(3, nil, 0)

	msg := &dns.Msg{}
	msg.SetQuestion("example.com.", dns.TypeA)

	cache.Set("key1", msg, 10*time.Second)
	cache.Set("key2", msg, 10*time.Second)
	cache.Set("key3", msg, 10*time.Second)
	cache.Set("key4", msg, 10*time.Second) // triggers eviction, hand is set

	cache.Clear()

	if cache.Len() != 0 {
		t.Errorf("expected 0 entries after clear, got %d", cache.Len())
	}

	// Re-fill and evict - hand should work from fresh state
	cache.Set("a", msg, 10*time.Second)
	cache.Set("b", msg, 10*time.Second)
	cache.Set("c", msg, 10*time.Second)
	cache.Set("d", msg, 10*time.Second)

	if cache.Len() != 3 {
		t.Errorf("expected 3 entries after re-fill eviction, got %d", cache.Len())
	}
}
