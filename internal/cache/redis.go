package cache

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/miekg/dns"
	"github.com/redis/go-redis/v9"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/metrics"
)

// redisKeysCacheTTL is how long to cache the Redis key count to avoid O(N) SCAN on every GetCacheStats poll.
const redisKeysCacheTTL = 30 * time.Second

type redisKeysCacheEntry struct {
	count int64
	until time.Time
}

type RedisCache struct {
	client              redis.UniversalClient
	lruCache            *ShardedLRUCache
	hitBatcher          *hitBatcher
	hitCounter          *ShardedHitCounter // local hit counts for non-blocking refresh decisions
	hits                uint64
	misses              uint64
	clusterMode         bool          // when true, use hash tags and split pipelines for Redis Cluster
	maxGracePeriod      time.Duration // max time to keep entries after soft expiry (L0 and L1)
	redisKeysCache      redisKeysCacheEntry
	redisKeysCacheMu    sync.Mutex
}

// Key prefixes for dnsmeta. Cluster mode uses {dnsmeta} hash tag so all keys
// hash to same slot, enabling pipelines without CROSSSLOT errors.
const (
	refreshLockPrefixStandalone = "dnsmeta:refresh:"
	hitPrefixStandalone         = "dnsmeta:hit:"
	sweepHitPrefixStandalone    = "dnsmeta:hit:sweep:"
	expiryIndexKeyStandalone    = "dnsmeta:expiry:index"
	refreshLockPrefixCluster    = "{dnsmeta}:refresh:"
	hitPrefixCluster            = "{dnsmeta}:hit:"
	sweepHitPrefixCluster       = "{dnsmeta}:hit:sweep:"
	expiryIndexKeyCluster       = "{dnsmeta}:expiry:index"
)

func (c *RedisCache) refreshLockPrefix() string {
	if c.clusterMode {
		return refreshLockPrefixCluster
	}
	return refreshLockPrefixStandalone
}

func (c *RedisCache) hitPrefix() string {
	if c.clusterMode {
		return hitPrefixCluster
	}
	return hitPrefixStandalone
}

func (c *RedisCache) sweepHitPrefix() string {
	if c.clusterMode {
		return sweepHitPrefixCluster
	}
	return sweepHitPrefixStandalone
}

func (c *RedisCache) expiryIndexKey() string {
	if c.clusterMode {
		return expiryIndexKeyCluster
	}
	return expiryIndexKeyStandalone
}

// countKeysByPrefix counts Redis keys matching the given pattern (e.g. "dns:*").
// Uses SCAN to avoid blocking; returns 0 on error.
func countKeysByPrefix(ctx context.Context, client redis.UniversalClient, pattern string) int64 {
	var total int64
	var cursor uint64
	for {
		keys, next, err := client.Scan(ctx, cursor, pattern, 1000).Result()
		if err != nil {
			return 0
		}
		total += int64(len(keys))
		cursor = next
		if cursor == 0 {
			break
		}
	}
	return total
}

func (c *RedisCache) getHash(ctx context.Context, key string) (*dns.Msg, time.Duration, error) {
	pipe := c.client.Pipeline()
	msgCmd := pipe.HGet(ctx, key, "msg")
	expCmd := pipe.HGet(ctx, key, "soft_expiry")
	_, _ = pipe.Exec(ctx)

	if err := msgCmd.Err(); err != nil {
		return nil, 0, err
	}
	data, err := msgCmd.Bytes()
	if err != nil {
		return nil, 0, err
	}
	msg := dnsMsgPool.Get().(*dns.Msg)
	if err := msg.Unpack(data); err != nil {
		dnsMsgPool.Put(msg)
		return nil, 0, err
	}
	softStr, err := expCmd.Result()
	if err != nil {
		return msg, 0, nil
	}
	softExpiry, err := strconv.ParseInt(softStr, 10, 64)
	if err != nil {
		return msg, 0, nil
	}
	remaining := time.Until(time.Unix(softExpiry, 0))
	return msg, remaining, nil
}

func (c *RedisCache) getLegacy(ctx context.Context, key string) (*dns.Msg, time.Duration, error) {
	pipe := c.client.Pipeline()
	getCmd := pipe.Get(ctx, key)
	ttlCmd := pipe.TTL(ctx, key)
	_, _ = pipe.Exec(ctx)

	if err := getCmd.Err(); err != nil {
		if err == redis.Nil {
			return nil, 0, nil
		}
		return nil, 0, err
	}

	data, err := getCmd.Bytes()
	if err != nil {
		return nil, 0, err
	}
	msg := dnsMsgPool.Get().(*dns.Msg)
	if err := msg.Unpack(data); err != nil {
		dnsMsgPool.Put(msg)
		return nil, 0, err
	}

	ttl := ttlCmd.Val()
	if ttlCmd.Err() != nil || ttl < 0 {
		ttl = 0
	}
	return msg, ttl, nil
}

func isWrongType(err error) bool {
	return err != nil && strings.Contains(err.Error(), "WRONGTYPE")
}

// NewRedisCache creates a Redis-backed cache. If logger is non-nil, L0 LRU evictions
// are logged at debug level (visible when logging.level is "debug").
func NewRedisCache(cfg config.RedisConfig, logger *slog.Logger) (*RedisCache, error) {
	mode := strings.ToLower(strings.TrimSpace(cfg.Mode))
	if mode == "" {
		mode = "standalone"
	}
	if mode != "standalone" && mode != "sentinel" && mode != "cluster" {
		mode = "standalone"
	}

	var client redis.UniversalClient
	switch mode {
	case "sentinel":
		if strings.TrimSpace(cfg.MasterName) == "" || len(cfg.SentinelAddrs) == 0 {
			return nil, fmt.Errorf("redis sentinel requires master_name and sentinel_addrs")
		}
		client = redis.NewFailoverClient(&redis.FailoverOptions{
			MasterName:       cfg.MasterName,
			SentinelAddrs:    cfg.SentinelAddrs,
			Password:         cfg.Password,
			DB:               cfg.DB,
			PoolSize:         50,
			MinIdleConns:     2,
			PoolFIFO:         true,
			ConnMaxIdleTime:  5 * time.Minute,
			ReadBufferSize:   16384,
			WriteBufferSize:  16384,
			MaxRetries:       3,
			DialTimeout:      2 * time.Second,
			ReadTimeout:      2 * time.Second,
			WriteTimeout:     2 * time.Second,
		})
	case "cluster":
		addrs := cfg.ClusterAddrs
		if len(addrs) == 0 && strings.TrimSpace(cfg.Address) != "" {
			addrs = strings.Split(cfg.Address, ",")
			for i := range addrs {
				addrs[i] = strings.TrimSpace(addrs[i])
			}
		}
		if len(addrs) == 0 {
			return nil, fmt.Errorf("redis cluster requires cluster_addrs or address (comma-separated)")
		}
		client = redis.NewClusterClient(&redis.ClusterOptions{
			Addrs:            addrs,
			Password:         cfg.Password,
			PoolSize:         50,
			MinIdleConns:     2,
			PoolFIFO:         true,
			ConnMaxIdleTime:  5 * time.Minute,
			ReadBufferSize:   16384,
			WriteBufferSize:  16384,
			MaxRetries:       3,
			DialTimeout:      2 * time.Second,
			ReadTimeout:     2 * time.Second,
			WriteTimeout:    2 * time.Second,
		})
	default:
		if strings.TrimSpace(cfg.Address) == "" {
			return nil, nil
		}
		// Standalone
		client = redis.NewClient(&redis.Options{
			Addr:            cfg.Address,
			DB:              cfg.DB,
			Password:        cfg.Password,
			PoolSize:        50,
			MinIdleConns:    2,
			PoolFIFO:        true,
			ConnMaxIdleTime: 5 * time.Minute,
			ReadBufferSize:  16384,
			WriteBufferSize: 16384,
			MaxRetries:     3,
			DialTimeout:    2 * time.Second,
			ReadTimeout:   2 * time.Second,
			WriteTimeout:  2 * time.Second,
		})
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		client.Close()
		return nil, err
	}
	
	// Create L0 cache (sharded in-memory LRU to reduce mutex contention at high QPS)
	// Default to 10000 entries if not specified
	lruSize := cfg.LRUSize
	if lruSize <= 0 {
		lruSize = 10000
	}
	maxGracePeriod := cfg.LRUGracePeriod.Duration
	if maxGracePeriod <= 0 {
		maxGracePeriod = time.Hour
	}
	var lru *ShardedLRUCache
	if lruSize > 0 {
		lru = NewShardedLRUCache(lruSize, logger, maxGracePeriod)
	}
	
	hitBatcher := newHitBatcher(client)
	hitCounterMaxEntries := cfg.HitCounterMaxEntries
	if hitCounterMaxEntries <= 0 {
		hitCounterMaxEntries = 10000
	}
	hitCounter := NewShardedHitCounter(hitCounterMaxEntries)

	return &RedisCache{
		client:         client,
		lruCache:       lru,
		hitBatcher:     hitBatcher,
		hitCounter:     hitCounter,
		clusterMode:    mode == "cluster",
		maxGracePeriod: maxGracePeriod,
	}, nil
}

func (c *RedisCache) ReleaseMsg(msg *dns.Msg) {
	if msg != nil {
		dnsMsgPool.Put(msg)
	}
}

func (c *RedisCache) Get(ctx context.Context, key string) (*dns.Msg, error) {
	msg, remaining, err := c.GetWithTTL(ctx, key)
	if err != nil {
		return nil, err
	}
	if remaining <= 0 {
		if msg != nil {
			c.ReleaseMsg(msg)
		}
		return nil, nil
	}
	return msg, nil
}

func (c *RedisCache) GetWithTTL(ctx context.Context, key string) (*dns.Msg, time.Duration, error) {
	if c == nil {
		return nil, 0, nil
	}
	
	// L0 Cache: Check local in-memory LRU cache first
	if c.lruCache != nil {
		if msg, ttl, ok := c.lruCache.Get(key); ok {
			atomic.AddUint64(&c.hits, 1)
			metrics.RecordCacheHit(true)
			return msg, ttl, nil
		}
	}

	// L1 Cache: Check Redis
	msg, remaining, err := c.getHash(ctx, key)
	if err == nil {
		// Populate L0 cache on Redis hit
		if c.lruCache != nil && msg != nil && remaining > 0 {
			c.lruCache.Set(key, msg, remaining)
		}
		atomic.AddUint64(&c.hits, 1)
		metrics.RecordCacheHit(false)
		return msg, remaining, nil
	}
	if err == redis.Nil || isWrongType(err) {
		msg, remaining, legacyErr := c.getLegacy(ctx, key)
		if legacyErr != nil && isWrongType(legacyErr) {
			_ = c.client.Del(ctx, key).Err()
			atomic.AddUint64(&c.misses, 1)
			metrics.RecordCacheMiss()
			return nil, 0, nil
		}
		if legacyErr == nil && msg != nil && remaining > 0 {
			_ = c.SetWithIndex(ctx, key, msg, remaining)
			atomic.AddUint64(&c.hits, 1)
			metrics.RecordCacheHit(false)
		} else {
			atomic.AddUint64(&c.misses, 1)
			metrics.RecordCacheMiss()
		}
		return msg, remaining, legacyErr
	}
	atomic.AddUint64(&c.misses, 1)
	metrics.RecordCacheMiss()
	return nil, 0, err
}

func (c *RedisCache) Set(ctx context.Context, key string, msg *dns.Msg, ttl time.Duration) error {
	if c == nil || msg == nil || ttl <= 0 {
		return nil
	}
	packed, err := msg.Pack()
	if err != nil {
		return err
	}
	return c.client.Set(ctx, key, packed, ttl).Err()
}

func (c *RedisCache) SetWithIndex(ctx context.Context, key string, msg *dns.Msg, ttl time.Duration) error {
	if c == nil || msg == nil || ttl <= 0 {
		return nil
	}
	
	// Update L0 cache first (fastest)
	if c.lruCache != nil {
		c.lruCache.Set(key, msg, ttl)
	}
	
	// Update L1 cache (Redis)
	packed, err := msg.Pack()
	if err != nil {
		return err
	}
	now := time.Now()
	softExpiry := now.Add(ttl)
	softExpiryUnix := softExpiry.Unix()
	createdAtUnix := now.Unix()
	// Grace period (matches LRU cache): min(ttl, maxGracePeriod) - keys auto-expire after expiry + grace
	// to prevent unbounded Redis memory growth if sweep misses keys
	gracePeriod := ttl
	if gracePeriod > c.maxGracePeriod {
		gracePeriod = c.maxGracePeriod
	}
	redisTTL := ttl + gracePeriod

	if c.clusterMode {
		// Split for Redis Cluster: dns keys and dnsmeta keys hash to different slots (CROSSSLOT).
		pipe1 := c.client.TxPipeline()
		pipe1.HSet(ctx, key, "msg", packed, "soft_expiry", softExpiryUnix, "created_at", createdAtUnix)
		pipe1.Expire(ctx, key, redisTTL)
		_, err = pipe1.Exec(ctx)
		if err != nil && isWrongType(err) {
			_ = c.client.Del(ctx, key).Err()
			return c.SetWithIndex(ctx, key, msg, ttl)
		}
		if err != nil {
			return err
		}
		return c.client.ZAdd(ctx, c.expiryIndexKey(), redis.Z{Score: float64(softExpiryUnix), Member: key}).Err()
	}
	// Standalone/sentinel: atomic pipeline
	pipe := c.client.TxPipeline()
	pipe.HSet(ctx, key, "msg", packed, "soft_expiry", softExpiryUnix, "created_at", createdAtUnix)
	pipe.ZAdd(ctx, c.expiryIndexKey(), redis.Z{Score: float64(softExpiryUnix), Member: key})
	pipe.Expire(ctx, key, redisTTL)
	_, err = pipe.Exec(ctx)
	if err != nil && isWrongType(err) {
		_ = c.client.Del(ctx, key).Err()
		return c.SetWithIndex(ctx, key, msg, ttl)
	}
	return err
}

func (c *RedisCache) IncrementHit(ctx context.Context, key string, window time.Duration) (int64, error) {
	if c == nil {
		return 0, nil
	}
	hitKey := c.hitPrefix() + key
	// Use local hit counter for immediate return; avoids blocking on Redis.
	// Batcher writes to Redis asynchronously for persistence and sweep.
	localCount := c.hitCounter.Increment(hitKey)
	c.hitBatcher.addHitFireAndForget(hitKey, window)
	return localCount, nil
}

func (c *RedisCache) GetHitCount(ctx context.Context, key string) (int64, error) {
	if c == nil {
		return 0, nil
	}
	count, err := c.client.Get(ctx, c.hitPrefix()+key).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return count, nil
}

func (c *RedisCache) IncrementSweepHit(ctx context.Context, key string, window time.Duration) (int64, error) {
	if c == nil {
		return 0, nil
	}
	sweepKey := c.sweepHitPrefix() + key
	c.hitBatcher.addSweepHit(sweepKey, window)
	return 0, nil
}

func (c *RedisCache) GetSweepHitCount(ctx context.Context, key string) (int64, error) {
	if c == nil {
		return 0, nil
	}
	sweepKey := c.sweepHitPrefix() + key
	count, err := c.client.Get(ctx, sweepKey).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return count, nil
}

// FlushHitBatcher persists all pending hit and sweep hit increments to Redis.
// Call before operations that depend on accurate hit counts (e.g. sweep refresh).
func (c *RedisCache) FlushHitBatcher() {
	if c == nil || c.hitBatcher == nil {
		return
	}
	c.hitBatcher.Flush()
}

func (c *RedisCache) TryAcquireRefresh(ctx context.Context, key string, ttl time.Duration) (bool, error) {
	if c == nil {
		return false, nil
	}
	if ttl <= 0 {
		ttl = 10 * time.Second
	}
	lockKey := c.refreshLockPrefix() + key
	return c.client.SetNX(ctx, lockKey, "1", ttl).Result()
}

func (c *RedisCache) ReleaseRefresh(ctx context.Context, key string) {
	if c == nil {
		return
	}
	lockKey := c.refreshLockPrefix() + key
	_, _ = c.client.Del(ctx, lockKey).Result()
}

type ExpiryCandidate struct {
	Key        string
	SoftExpiry time.Time
}

// CandidateCheckResult holds the result of BatchCandidateChecks for one candidate.
// CreatedAt is when the cache entry was first stored; zero means unknown (e.g. legacy key).
// Used to only delete "cold" keys that have had at least sweep_hit_window to accumulate hits.
type CandidateCheckResult struct {
	Exists    bool
	SweepHits int64
	CreatedAt time.Time
}

func (c *RedisCache) ExpiryCandidates(ctx context.Context, until time.Time, limit int) ([]ExpiryCandidate, error) {
	if c == nil {
		return nil, nil
	}
	if limit <= 0 {
		return nil, nil
	}
	max := fmt.Sprintf("%d", until.Unix())
	results, err := c.client.ZRangeByScoreWithScores(ctx, c.expiryIndexKey(), &redis.ZRangeBy{
		Min:    "-inf",
		Max:    max,
		Offset: 0,
		Count:  int64(limit),
	}).Result()
	if err != nil {
		return nil, err
	}
	candidates := make([]ExpiryCandidate, 0, len(results))
	for _, result := range results {
		key, ok := result.Member.(string)
		if !ok {
			continue
		}
		softExpiry := time.Unix(int64(result.Score), 0)
		candidates = append(candidates, ExpiryCandidate{Key: key, SoftExpiry: softExpiry})
	}
	return candidates, nil
}

func (c *RedisCache) RemoveFromIndex(ctx context.Context, key string) {
	if c == nil {
		return
	}
	_, _ = c.client.ZRem(ctx, c.expiryIndexKey(), key).Result()
}

// ReconcileExpiryIndex samples keys from the expiry index and removes entries for cache keys that no longer exist.
// Samples the oldest entries (by score) since those are most likely stale after Redis TTL eviction.
func (c *RedisCache) ReconcileExpiryIndex(ctx context.Context, sampleSize int) (int, error) {
	if c == nil || sampleSize <= 0 {
		return 0, nil
	}
	results, err := c.client.ZRange(ctx, c.expiryIndexKey(), 0, int64(sampleSize-1)).Result()
	if err != nil {
		return 0, err
	}
	if len(results) == 0 {
		return 0, nil
	}
	// Check existence: standalone can pipeline; cluster must do per-key (cache keys hash to different slots)
	orphans := make([]string, 0, len(results))
	if c.clusterMode {
		for _, key := range results {
			n, err := c.client.Exists(ctx, key).Result()
			if err != nil || n == 0 {
				orphans = append(orphans, key)
			}
		}
	} else {
		pipe := c.client.Pipeline()
		cmds := make([]*redis.IntCmd, len(results))
		for i, key := range results {
			cmds[i] = pipe.Exists(ctx, key)
		}
		if _, err := pipe.Exec(ctx); err != nil {
			return 0, err
		}
		for i, cmd := range cmds {
			n, _ := cmd.Result()
			if n == 0 {
				orphans = append(orphans, results[i])
			}
		}
	}
	if len(orphans) == 0 {
		return 0, nil
	}
	// ZREM accepts multiple members (variadic interface{})
	members := make([]interface{}, len(orphans))
	for i, k := range orphans {
		members[i] = k
	}
	if _, err := c.client.ZRem(ctx, c.expiryIndexKey(), members...).Result(); err != nil {
		return 0, err
	}
	return len(orphans), nil
}

// DeleteCacheKey removes a key from both the expiry index and deletes the cache entry.
// Use when a key is no longer needed (e.g. during sweep when not refreshing cold keys)
// to prevent unbounded Redis memory growth.
func (c *RedisCache) DeleteCacheKey(ctx context.Context, key string) {
	if c == nil {
		return
	}
	if c.clusterMode {
		// Split for Redis Cluster: expiryIndexKey and dns key hash to different slots.
		_, _ = c.client.ZRem(ctx, c.expiryIndexKey(), key).Result()
		_, _ = c.client.Del(ctx, key).Result()
	} else {
		// Standalone/sentinel: atomic pipeline
		pipe := c.client.TxPipeline()
		pipe.ZRem(ctx, c.expiryIndexKey(), key)
		pipe.Del(ctx, key)
		_, _ = pipe.Exec(ctx)
	}
	// Also evict from L0 cache if present
	if c.lruCache != nil {
		c.lruCache.Delete(key)
	}
}

func (c *RedisCache) TTL(ctx context.Context, key string) (time.Duration, error) {
	if c == nil {
		return 0, nil
	}
	ttl, err := c.client.TTL(ctx, key).Result()
	if err != nil {
		return 0, err
	}
	return ttl, nil
}

func (c *RedisCache) Exists(ctx context.Context, key string) (bool, error) {
	if c == nil {
		return false, nil
	}
	count, err := c.client.Exists(ctx, key).Result()
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// BatchCandidateChecks pipelines Exists and GetSweepHitCount to reduce Redis round-trips.
// In standalone mode, both are pipelined. In cluster mode, sweep hit GETs are pipelined (same slot);
// Exists must be done per-key since cache keys hash to different slots.
func (c *RedisCache) BatchCandidateChecks(ctx context.Context, candidates []ExpiryCandidate, sweepHitWindow time.Duration) ([]CandidateCheckResult, error) {
	if c == nil || len(candidates) == 0 {
		return nil, nil
	}
	results := make([]CandidateCheckResult, len(candidates))

	// Pipeline sweep hit GETs (all use dnsmeta slot in cluster, so we can batch).
	sweepPrefix := c.sweepHitPrefix()
	pipe := c.client.Pipeline()
	cmds := make([]*redis.StringCmd, len(candidates))
	for i, cand := range candidates {
		sweepKey := sweepPrefix + cand.Key
		cmds[i] = pipe.Get(ctx, sweepKey)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		// Fall back to individual calls on pipeline error
		for i := range candidates {
			exists, _ := c.Exists(ctx, candidates[i].Key)
			var sweepHits int64
			if sweepHitWindow > 0 {
				sweepHits, _ = c.GetSweepHitCount(ctx, candidates[i].Key)
			}
			var createdAt time.Time
			if exists {
				createdAt, _ = c.getCreatedAt(ctx, candidates[i].Key)
			}
			results[i] = CandidateCheckResult{Exists: exists, SweepHits: sweepHits, CreatedAt: createdAt}
		}
		return results, nil
	}
	for i, cmd := range cmds {
		sweepHits := int64(0)
		if v, err := cmd.Int64(); err == nil {
			sweepHits = v
		}
		results[i].SweepHits = sweepHits
	}

	// Exists + CreatedAt: standalone can pipeline; cluster must do per-key (different slots).
	if c.clusterMode {
		for i, cand := range candidates {
			exists, err := c.client.Exists(ctx, cand.Key).Result()
			if err != nil {
				exists = 0
			}
			results[i].Exists = exists > 0
			if results[i].Exists {
				results[i].CreatedAt, _ = c.getCreatedAt(ctx, cand.Key)
			}
		}
	} else {
		pipe = c.client.Pipeline()
		existsCmds := make([]*redis.IntCmd, len(candidates))
		createdAtCmds := make([]*redis.StringCmd, len(candidates))
		for i, cand := range candidates {
			existsCmds[i] = pipe.Exists(ctx, cand.Key)
			createdAtCmds[i] = pipe.HGet(ctx, cand.Key, "created_at")
		}
		if _, err := pipe.Exec(ctx); err != nil {
			for i := range candidates {
				results[i].Exists, _ = c.Exists(ctx, candidates[i].Key)
				if results[i].Exists {
					results[i].CreatedAt, _ = c.getCreatedAt(ctx, candidates[i].Key)
				}
			}
		} else {
			for i, cmd := range existsCmds {
				n, _ := cmd.Result()
				results[i].Exists = n > 0
				if results[i].Exists {
					results[i].CreatedAt = parseCreatedAt(createdAtCmds[i])
				}
			}
		}
	}
	return results, nil
}

// getCreatedAt returns the created_at timestamp for a cache key (hash field). Zero time if missing or invalid.
func (c *RedisCache) getCreatedAt(ctx context.Context, key string) (time.Time, error) {
	val, err := c.client.HGet(ctx, key, "created_at").Result()
	if err != nil || val == "" {
		return time.Time{}, nil
	}
	sec, err := strconv.ParseInt(val, 10, 64)
	if err != nil {
		return time.Time{}, nil
	}
	return time.Unix(sec, 0), nil
}

// parseCreatedAt parses HGet result for "created_at"; returns zero time if missing or invalid.
func parseCreatedAt(cmd *redis.StringCmd) time.Time {
	val, err := cmd.Result()
	if err != nil || val == "" {
		return time.Time{}
	}
	sec, err := strconv.ParseInt(val, 10, 64)
	if err != nil {
		return time.Time{}
	}
	return time.Unix(sec, 0)
}

func (c *RedisCache) Close() error {
	if c == nil {
		return nil
	}
	if c.hitBatcher != nil {
		c.hitBatcher.stop()
	}
	if c.lruCache != nil {
		c.lruCache.Clear()
	}
	return c.client.Close()
}

// GetLRUStats returns statistics about the L0 cache
func (c *RedisCache) GetLRUStats() *LRUStats {
	if c == nil || c.lruCache == nil {
		return nil
	}
	stats := c.lruCache.Stats()
	return &stats
}

// GetCacheStats returns overall cache statistics
func (c *RedisCache) GetCacheStats() CacheStats {
	hits := atomic.LoadUint64(&c.hits)
	misses := atomic.LoadUint64(&c.misses)
	total := hits + misses
	hitRate := 0.0
	if total > 0 {
		hitRate = float64(hits) / float64(total) * 100.0
	}

	stats := CacheStats{
		Hits:    hits,
		Misses:  misses,
		HitRate: hitRate,
	}

	if c.lruCache != nil {
		lruStats := c.lruCache.Stats()
		stats.LRU = &lruStats
	}

	// L1 (Redis) key count: DNS cache entries only (dns:* keys). Cached 30s to avoid O(N) SCAN on every poll.
	var redisKeys int64
	if c.client != nil {
		c.redisKeysCacheMu.Lock()
		if time.Now().Before(c.redisKeysCache.until) {
			redisKeys = c.redisKeysCache.count
			c.redisKeysCacheMu.Unlock()
		} else {
			c.redisKeysCacheMu.Unlock()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			redisKeys = countKeysByPrefix(ctx, c.client, "dns:*")
			cancel()
			c.redisKeysCacheMu.Lock()
			c.redisKeysCache = redisKeysCacheEntry{count: redisKeys, until: time.Now().Add(redisKeysCacheTTL)}
			c.redisKeysCacheMu.Unlock()
		}
		stats.RedisKeys = redisKeys
	}

	return stats
}

// CacheStats contains overall cache statistics
type CacheStats struct {
	Hits      uint64     `json:"hits"`
	Misses    uint64     `json:"misses"`
	HitRate   float64    `json:"hit_rate"`
	LRU       *LRUStats  `json:"lru,omitempty"`
	RedisKeys int64      `json:"redis_keys,omitempty"` // L1 key count
}

// CleanLRUCache removes expired entries from the L0 cache
func (c *RedisCache) CleanLRUCache() int {
	if c == nil || c.lruCache == nil {
		return 0
	}
	return c.lruCache.CleanExpired()
}

// deleteKeysByPrefix deletes all Redis keys matching the given pattern (e.g. "dns:*").
// Uses SCAN to iterate and DEL in batches. Returns the number of keys deleted or error.
func deleteKeysByPrefix(ctx context.Context, client redis.UniversalClient, pattern string) (int64, error) {
	var total int64
	var cursor uint64
	for {
		keys, next, err := client.Scan(ctx, cursor, pattern, 500).Result()
		if err != nil {
			return total, err
		}
		if len(keys) > 0 {
			n, err := client.Del(ctx, keys...).Result()
			if err != nil {
				return total, err
			}
			total += n
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
	return total, nil
}

// ClearCache removes all DNS cache entries and metadata from Redis (dns:* and dnsmeta:* keys)
// and clears the L0 LRU cache. Use for a full cache reset.
func (c *RedisCache) ClearCache(ctx context.Context) error {
	if c == nil {
		return nil
	}
	// Invalidate key count cache so next GetCacheStats gets fresh count
	c.redisKeysCacheMu.Lock()
	c.redisKeysCache = redisKeysCacheEntry{}
	c.redisKeysCacheMu.Unlock()
	// Clear L0 cache first
	if c.lruCache != nil {
		c.lruCache.Clear()
	}
	if c.client == nil {
		return nil
	}
	// Delete dns:* keys (DNS cache entries)
	if _, err := deleteKeysByPrefix(ctx, c.client, "dns:*"); err != nil {
		return fmt.Errorf("clear dns keys: %w", err)
	}
	// Delete dnsmeta keys (hit counters, expiry index, refresh locks).
	// Use mode-specific pattern for backward compatibility.
	if c.clusterMode {
		if _, err := deleteKeysByPrefix(ctx, c.client, "{dnsmeta}:*"); err != nil {
			return fmt.Errorf("clear dnsmeta keys: %w", err)
		}
	} else {
		if _, err := deleteKeysByPrefix(ctx, c.client, "dnsmeta:*"); err != nil {
			return fmt.Errorf("clear dnsmeta keys: %w", err)
		}
	}
	return nil
}
