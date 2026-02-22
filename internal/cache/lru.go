package cache

import (
	"container/list"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/miekg/dns"
)

// dnsMsgPool reuses *dns.Msg for cache Get to reduce mallocgc (dns.Copy was ~27% of CPU).
var dnsMsgPool = sync.Pool{
	New: func() any { return new(dns.Msg) },
}

// Shard count for ShardedLRUCache. Reduces mutex contention by distributing
// load across independent locks. 32 shards = ~32x less contention at 23k+ qps.
const defaultLRUShardCount = 32

// LRUCache is a thread-safe in-memory cache for DNS responses.
// Uses SIEVE eviction (NSDI '24): cache hits only set a visited bit—no list
// reordering—so Get uses RLock instead of Lock, improving read concurrency.
type LRUCache struct {
	maxEntries     int
	maxGracePeriod time.Duration // max time to keep entry after soft expiry (default 1h)
	mu             sync.RWMutex
	ll             *list.List
	cache          map[string]*list.Element
	hand           *list.Element // SIEVE hand: next eviction candidate (moves tail→head)
	log            *slog.Logger  // optional; when set, logs evictions at debug level
}

type lruEntry struct {
	key        string
	msg        *dns.Msg
	expiry     time.Time
	softExpiry time.Time
	visited    uint32 // SIEVE: 1 if accessed since hand passed; atomic for lock-free Get path
}

// NewLRUCache creates a new LRU cache with the specified maximum number of entries.
// If logger is non-nil, evictions are logged at debug level.
// maxGracePeriod is the max time to keep entries after soft expiry (0 = 1h default).
func NewLRUCache(maxEntries int, logger *slog.Logger, maxGracePeriod time.Duration) *LRUCache {
	if maxEntries <= 0 {
		maxEntries = 1000
	}
	if maxGracePeriod <= 0 {
		maxGracePeriod = time.Hour
	}
	return &LRUCache{
		maxEntries:     maxEntries,
		maxGracePeriod: maxGracePeriod,
		ll:             list.New(),
		cache:          make(map[string]*list.Element),
		log:            logger,
	}
}

// Get retrieves a DNS message from the cache.
// Returns a copy (from pool via CopyTo) and remaining TTL (0 if expired or not found).
// Caller MUST call ReleaseMsg when done. Uses RLock for the hot path (hit, not expired).
func (c *LRUCache) Get(key string) (*dns.Msg, time.Duration, bool) {
	c.mu.RLock()
	elem, ok := c.cache[key]
	if !ok {
		c.mu.RUnlock()
		return nil, 0, false
	}
	entry := elem.Value.(*lruEntry)
	now := time.Now()
	if now.After(entry.expiry) {
		c.mu.RUnlock()
		c.mu.Lock()
		defer c.mu.Unlock()
		if e, ok := c.cache[key]; ok {
			ent := e.Value.(*lruEntry)
			if now.After(ent.expiry) {
				c.removeElement(e)
			}
		}
		return nil, 0, false
	}
	atomic.StoreUint32(&entry.visited, 1)
	remaining := entry.softExpiry.Sub(now)
	if remaining < 0 {
		remaining = 0
	}
	msg := dnsMsgPool.Get().(*dns.Msg)
	entry.msg.CopyTo(msg)
	c.mu.RUnlock()
	return msg, remaining, true
}

// Set adds or updates a DNS message in the cache.
// New entries go at head (Front). Eviction uses SIEVE: hand scans tail→head,
// evicts first unvisited entry (or clears visited and advances).
func (c *LRUCache) Set(key string, msg *dns.Msg, ttl time.Duration) {
	if msg == nil || ttl <= 0 {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	softExpiry := now.Add(ttl)
	gracePeriod := ttl
	if gracePeriod > c.maxGracePeriod {
		gracePeriod = c.maxGracePeriod
	}
	expiry := softExpiry.Add(gracePeriod)

	if elem, ok := c.cache[key]; ok {
		entry := elem.Value.(*lruEntry)
		entry.msg = msg.Copy()
		entry.expiry = expiry
		entry.softExpiry = softExpiry
		atomic.StoreUint32(&entry.visited, 1)
		return
	}

	entry := &lruEntry{
		key:        key,
		msg:        msg.Copy(),
		expiry:     expiry,
		softExpiry: softExpiry,
		visited:    1, // new entries start visited (just inserted)
	}
	elem := c.ll.PushFront(entry)
	c.cache[key] = elem

	for c.ll.Len() > c.maxEntries {
		c.evictOne()
	}
}

// evictOne runs one iteration of SIEVE: evict the entry at hand, or clear
// visited and advance. Hand moves tail→head (Back→Front); wraps to Back when past Front.
// Must hold c.mu.
func (c *LRUCache) evictOne() {
	if c.ll.Len() == 0 {
		return
	}
	if c.hand == nil {
		c.hand = c.ll.Back()
	}
	for {
		if c.hand == nil {
			return
		}
		entry := c.hand.Value.(*lruEntry)
		next := c.hand.Prev() // toward head (newer); nil when at Front
		if next == nil {
			next = c.ll.Back() // wrap to tail
		}
		if atomic.LoadUint32(&entry.visited) == 1 {
			atomic.StoreUint32(&entry.visited, 0)
			c.hand = next
			continue
		}
		if c.log != nil {
			c.log.Debug("L0 cache eviction", "key", entry.key, "capacity", c.maxEntries)
		}
		toRemove := c.hand
		c.hand = next
		c.removeElement(toRemove)
		if c.ll.Len() <= c.maxEntries {
			return
		}
	}
}

// Delete removes a key from the cache
func (c *LRUCache) Delete(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.cache[key]; ok {
		c.removeElement(elem)
	}
}

// Clear removes all entries from the cache
func (c *LRUCache) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.ll.Init()
	c.cache = make(map[string]*list.Element)
	c.hand = nil
}

// Len returns the current number of entries in the cache
func (c *LRUCache) Len() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.ll.Len()
}

// Stats returns cache statistics
func (c *LRUCache) Stats() LRUStats {
	c.mu.RLock()
	defer c.mu.RUnlock()

	now := time.Now()
	fresh := 0
	stale := 0
	expired := 0

	for e := c.ll.Front(); e != nil; e = e.Next() {
		entry := e.Value.(*lruEntry)
		if now.After(entry.expiry) {
			expired++
		} else if now.After(entry.softExpiry) {
			stale++
		} else {
			fresh++
		}
	}

	return LRUStats{
		Entries:    c.ll.Len(),
		MaxEntries: c.maxEntries,
		Fresh:      fresh,
		Stale:      stale,
		Expired:    expired,
	}
}

// LRUStats contains statistics about the LRU cache
type LRUStats struct {
	Entries    int `json:"entries"`
	MaxEntries int `json:"max_entries"`
	Fresh      int `json:"fresh"`
	Stale      int `json:"stale"`
	Expired    int `json:"expired"`
}

// ShardedLRUCache wraps multiple LRUCache shards to reduce mutex contention.
// At high QPS (23k+), a single LRU mutex becomes a bottleneck; sharding
// distributes load across independent locks so throughput scales with CPU cores.
type ShardedLRUCache struct {
	shards []*LRUCache
	mask   uint32 // shardCount-1 for fast modulo when shardCount is power of 2
}

// NewShardedLRUCache creates a sharded LRU cache with the given total capacity.
// Uses defaultLRUShardCount shards; each shard gets capacity/shardCount entries.
// For small configs (< 3200), uses a single shard so the config is respected.
// If logger is non-nil, evictions are logged at debug level.
// maxGracePeriod is the max time to keep entries after soft expiry (0 = 1h default).
func NewShardedLRUCache(maxEntries int, logger *slog.Logger, maxGracePeriod time.Duration) *ShardedLRUCache {
	shardCount := defaultLRUShardCount
	perShard := (maxEntries + shardCount - 1) / shardCount
	if perShard < 100 {
		// Small config: use single shard so total capacity matches config
		shardCount = 1
		perShard = maxEntries
	}
	shards := make([]*LRUCache, shardCount)
	for i := range shards {
		shards[i] = NewLRUCache(perShard, logger, maxGracePeriod)
	}
	return &ShardedLRUCache{
		shards: shards,
		mask:   uint32(shardCount - 1),
	}
}

// shardIndex uses inline FNV-1a (allocation-free) for fast shard selection.
// Avoids fnv.New32a() per call which allocated ~50B at 23k+ qps.
func (s *ShardedLRUCache) shardIndex(key string) uint32 {
	const prime32 = 16777619
	h := uint32(2166136261)
	for i := 0; i < len(key); i++ {
		h ^= uint32(key[i])
		h *= prime32
	}
	return h & s.mask
}

// Get delegates to the appropriate shard.
func (s *ShardedLRUCache) Get(key string) (*dns.Msg, time.Duration, bool) {
	return s.shards[s.shardIndex(key)].Get(key)
}

// Set delegates to the appropriate shard.
func (s *ShardedLRUCache) Set(key string, msg *dns.Msg, ttl time.Duration) {
	s.shards[s.shardIndex(key)].Set(key, msg, ttl)
}

// Delete delegates to the appropriate shard.
func (s *ShardedLRUCache) Delete(key string) {
	s.shards[s.shardIndex(key)].Delete(key)
}

// Clear clears all shards.
func (s *ShardedLRUCache) Clear() {
	for _, shard := range s.shards {
		shard.Clear()
	}
}

// Len returns the sum of entries across all shards.
func (s *ShardedLRUCache) Len() int {
	n := 0
	for _, shard := range s.shards {
		n += shard.Len()
	}
	return n
}

// Stats aggregates statistics from all shards.
func (s *ShardedLRUCache) Stats() LRUStats {
	var total LRUStats
	for _, shard := range s.shards {
		st := shard.Stats()
		total.Entries += st.Entries
		total.MaxEntries += st.MaxEntries
		total.Fresh += st.Fresh
		total.Stale += st.Stale
		total.Expired += st.Expired
	}
	return total
}

// CleanExpired cleans expired entries from all shards.
func (s *ShardedLRUCache) CleanExpired() int {
	n := 0
	for _, shard := range s.shards {
		n += shard.CleanExpired()
	}
	return n
}

// removeElement removes an element from the cache
// Must be called with c.mu held
func (c *LRUCache) removeElement(elem *list.Element) {
	c.ll.Remove(elem)
	entry := elem.Value.(*lruEntry)
	delete(c.cache, entry.key)
}

// CleanExpired removes all expired entries from the cache
// Returns the number of entries removed
func (c *LRUCache) CleanExpired() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	removed := 0
	var next *list.Element

	for e := c.ll.Front(); e != nil; e = next {
		next = e.Next()
		entry := e.Value.(*lruEntry)
		if now.After(entry.expiry) {
			c.removeElement(e)
			removed++
		}
	}

	return removed
}
