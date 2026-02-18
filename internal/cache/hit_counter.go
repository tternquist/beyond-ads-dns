package cache

import (
	"container/list"
	"sync"
	"sync/atomic"
)

const defaultHitCounterShardCount = 32
const defaultHitCounterMaxEntries = 10000

// ShardedHitCounter provides in-memory hit counts with minimal lock contention.
// Used for refresh decisions so IncrementHit can return immediately without
// blocking on Redis. Counts are still written to Redis via the hit batcher
// for persistence and sweep (GetSweepHitCount).
// Uses LRU eviction when maxEntries is exceeded to bound memory growth.
type ShardedHitCounter struct {
	shards    []*hitCounterShard
	mask      uint32
	maxEntries int
}

type hitCounterShard struct {
	mu        sync.Mutex
	entries   map[string]*list.Element
	ll        *list.List
	maxEntries int
}

type hitEntry struct {
	key   string
	count *atomic.Int64
}

// NewShardedHitCounter creates a sharded in-memory hit counter with LRU eviction.
// maxEntries is the total capacity across all shards; 0 uses defaultHitCounterMaxEntries.
func NewShardedHitCounter(maxEntries int) *ShardedHitCounter {
	if maxEntries <= 0 {
		maxEntries = defaultHitCounterMaxEntries
	}
	perShard := (maxEntries + defaultHitCounterShardCount - 1) / defaultHitCounterShardCount
	if perShard < 1 {
		perShard = 1
	}
	shards := make([]*hitCounterShard, defaultHitCounterShardCount)
	for i := range shards {
		shards[i] = &hitCounterShard{
			entries:    make(map[string]*list.Element),
			ll:         list.New(),
			maxEntries: perShard,
		}
	}
	return &ShardedHitCounter{
		shards:     shards,
		mask:       defaultHitCounterShardCount - 1,
		maxEntries: maxEntries,
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
// Evicts least-recently-used entries when the shard exceeds capacity.
func (s *ShardedHitCounter) Increment(key string) int64 {
	shard := s.shards[s.shardIndex(key)]
	shard.mu.Lock()
	defer shard.mu.Unlock()

	elem, ok := shard.entries[key]
	if ok {
		entry := elem.Value.(*hitEntry)
		shard.ll.MoveToFront(elem)
		return entry.count.Add(1)
	}

	// New entry; evict if at capacity
	for shard.ll.Len() >= shard.maxEntries && shard.ll.Len() > 0 {
		oldest := shard.ll.Back()
		if oldest == nil {
			break
		}
		evicted := oldest.Value.(*hitEntry)
		shard.ll.Remove(oldest)
		delete(shard.entries, evicted.key)
	}

	entry := &hitEntry{key: key, count: &atomic.Int64{}}
	elem = shard.ll.PushFront(entry)
	shard.entries[key] = elem
	return entry.count.Add(1)
}
