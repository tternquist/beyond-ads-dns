package cache

import (
	"sync"
	"sync/atomic"
)

const defaultHitCounterShardCount = 32

// ShardedHitCounter provides in-memory hit counts with minimal lock contention.
// Used for refresh decisions so IncrementHit can return immediately without
// blocking on Redis. Counts are still written to Redis via the hit batcher
// for persistence and sweep (GetSweepHitCount).
type ShardedHitCounter struct {
	shards []*hitCounterShard
	mask   uint32
}

type hitCounterShard struct {
	mu      sync.Mutex
	entries map[string]*atomic.Int64
}

// NewShardedHitCounter creates a sharded in-memory hit counter.
func NewShardedHitCounter() *ShardedHitCounter {
	shards := make([]*hitCounterShard, defaultHitCounterShardCount)
	for i := range shards {
		shards[i] = &hitCounterShard{
			entries: make(map[string]*atomic.Int64),
		}
	}
	return &ShardedHitCounter{
		shards: shards,
		mask:   defaultHitCounterShardCount - 1,
	}
}

// shardIndex uses inline FNV-1a (allocation-free) for fast shard selection.
func (s *ShardedHitCounter) shardIndex(key string) uint32 {
	const prime32 = 16777619
	h := uint32(2166136261)
	for i := 0; i < len(key); i++ {
		h ^= uint32(key[i])
		h *= prime32
	}
	return h & s.mask
}

// Increment increments the count for key and returns the new value.
func (s *ShardedHitCounter) Increment(key string) int64 {
	shard := s.shards[s.shardIndex(key)]
	shard.mu.Lock()
	cnt, ok := shard.entries[key]
	if !ok {
		cnt = &atomic.Int64{}
		shard.entries[key] = cnt
	}
	shard.mu.Unlock()
	return cnt.Add(1)
}
