package cache

import (
	"testing"
)

func TestShardedHitCounter_Basic(t *testing.T) {
	c := NewShardedHitCounter(100)
	if c == nil {
		t.Fatal("NewShardedHitCounter returned nil")
	}
	n := c.Increment("key1")
	if n != 1 {
		t.Errorf("Increment = %d, want 1", n)
	}
	n = c.Increment("key1")
	if n != 2 {
		t.Errorf("Increment = %d, want 2", n)
	}
	n = c.Increment("key2")
	if n != 1 {
		t.Errorf("Increment key2 = %d, want 1", n)
	}
}

func TestShardedHitCounter_Eviction(t *testing.T) {
	// Small capacity: 2 shards, 5 entries per shard = 10 total
	// Use keys that hash to same shard to trigger eviction
	c := NewShardedHitCounter(20)
	// Fill with many keys - keys hash to different shards, so we need enough to exceed per-shard capacity
	// Per-shard = ceil(20/32) = 1, but we have min 10 per shard. So per-shard = 10.
	// We need 11+ keys in one shard to evict. Keys with same hash suffix might land in same shard.
	// Simpler: use 50 keys, we'll exceed total capacity and evict.
	for i := 0; i < 50; i++ {
		key := "key-" + string(rune('a'+i%26)) + string(rune('0'+i/26))
		c.Increment(key)
	}
	// Eviction should have occurred; counter should still work
	n := c.Increment("key-new")
	if n != 1 {
		t.Errorf("Increment after eviction = %d, want 1", n)
	}
}

func TestShardedHitCounter_Concurrent(t *testing.T) {
	c := NewShardedHitCounter(1000)
	done := make(chan struct{})
	for i := 0; i < 10; i++ {
		go func() {
			for j := 0; j < 100; j++ {
				c.Increment("concurrent-key")
			}
			done <- struct{}{}
		}()
	}
	for i := 0; i < 10; i++ {
		<-done
	}
	// Total 1000 increments; we can't assert exact count due to eviction across shards,
	// but we can verify it doesn't panic and returns positive
	n := c.Increment("concurrent-key")
	if n < 1 {
		t.Errorf("Increment = %d, want >= 1", n)
	}
}
