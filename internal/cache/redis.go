package cache

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/miekg/dns"
	"github.com/redis/go-redis/v9"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/metrics"
)

type RedisCache struct {
	client     redis.UniversalClient
	lruCache   *ShardedLRUCache
	hitBatcher *hitBatcher
	hits       uint64
	misses     uint64
}

const (
	refreshLockPrefix = "dnsmeta:refresh:"
	hitPrefix         = "dnsmeta:hit:"
	sweepHitPrefix    = "dnsmeta:hit:sweep:"
	expiryIndexKey = "dnsmeta:expiry:index"
)

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
	msg := new(dns.Msg)
	if err := msg.Unpack(data); err != nil {
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
	msg := new(dns.Msg)
	if err := msg.Unpack(data); err != nil {
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

func NewRedisCache(cfg config.RedisConfig) (*RedisCache, error) {
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
	var lru *ShardedLRUCache
	if lruSize > 0 {
		lru = NewShardedLRUCache(lruSize)
	}
	
	hitBatcher := newHitBatcher(client)

	return &RedisCache{
		client:     client,
		lruCache:   lru,
		hitBatcher: hitBatcher,
	}, nil
}

func (c *RedisCache) Get(ctx context.Context, key string) (*dns.Msg, error) {
	msg, remaining, err := c.GetWithTTL(ctx, key)
	if err != nil {
		return nil, err
	}
	if remaining <= 0 {
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
	softExpiry := time.Now().Add(ttl)
	softExpiryUnix := softExpiry.Unix()
	// Grace period (matches LRU cache): min(ttl, 1h) - keys auto-expire after expiry + grace
	// to prevent unbounded Redis memory growth if sweep misses keys
	gracePeriod := ttl
	if gracePeriod > time.Hour {
		gracePeriod = time.Hour
	}
	redisTTL := ttl + gracePeriod

	pipe := c.client.TxPipeline()
	pipe.HSet(ctx, key, "msg", packed, "soft_expiry", softExpiryUnix)
	pipe.ZAdd(ctx, expiryIndexKey, redis.Z{Score: float64(softExpiryUnix), Member: key})
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
	hitKey := hitPrefix + key
	future := c.hitBatcher.addHit(hitKey, window)
	select {
	case count := <-future:
		return count, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

func (c *RedisCache) GetHitCount(ctx context.Context, key string) (int64, error) {
	if c == nil {
		return 0, nil
	}
	count, err := c.client.Get(ctx, hitPrefix+key).Int64()
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
	sweepKey := sweepHitPrefix + key
	c.hitBatcher.addSweepHit(sweepKey, window)
	return 0, nil
}

func (c *RedisCache) GetSweepHitCount(ctx context.Context, key string) (int64, error) {
	if c == nil {
		return 0, nil
	}
	sweepKey := sweepHitPrefix + key
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
	lockKey := refreshLockPrefix + key
	return c.client.SetNX(ctx, lockKey, "1", ttl).Result()
}

func (c *RedisCache) ReleaseRefresh(ctx context.Context, key string) {
	if c == nil {
		return
	}
	lockKey := refreshLockPrefix + key
	_, _ = c.client.Del(ctx, lockKey).Result()
}

type ExpiryCandidate struct {
	Key        string
	SoftExpiry time.Time
}

func (c *RedisCache) ExpiryCandidates(ctx context.Context, until time.Time, limit int) ([]ExpiryCandidate, error) {
	if c == nil {
		return nil, nil
	}
	if limit <= 0 {
		return nil, nil
	}
	max := fmt.Sprintf("%d", until.Unix())
	results, err := c.client.ZRangeByScoreWithScores(ctx, expiryIndexKey, &redis.ZRangeBy{
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
	_, _ = c.client.ZRem(ctx, expiryIndexKey, key).Result()
}

// DeleteCacheKey removes a key from both the expiry index and deletes the cache entry.
// Use when a key is no longer needed (e.g. during sweep when not refreshing cold keys)
// to prevent unbounded Redis memory growth.
func (c *RedisCache) DeleteCacheKey(ctx context.Context, key string) {
	if c == nil {
		return
	}
	pipe := c.client.TxPipeline()
	pipe.ZRem(ctx, expiryIndexKey, key)
	pipe.Del(ctx, key)
	_, _ = pipe.Exec(ctx)
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

	// L1 (Redis) key count: DNS cache entries only (dns:* keys)
	if c.client != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		n := countKeysByPrefix(ctx, c.client, "dns:*")
		cancel()
		stats.RedisKeys = n
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
	// Delete dnsmeta:* keys (hit counters, expiry index, refresh locks)
	if _, err := deleteKeysByPrefix(ctx, c.client, "dnsmeta:*"); err != nil {
		return fmt.Errorf("clear dnsmeta keys: %w", err)
	}
	return nil
}
