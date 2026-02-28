package cache

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/miekg/dns"
	"github.com/redis/go-redis/v9"
	"github.com/tternquist/beyond-ads-dns/internal/config"
)

func TestRedisCacheHitBatcher(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	defer mr.Close()

	cfg := config.RedisConfig{
		Mode:    "standalone",
		Address: mr.Addr(),
	}
	c, err := NewRedisCache(cfg, nil)
	if err != nil {
		t.Fatalf("NewRedisCache: %v", err)
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	key := "test-key"
	window := 48 * time.Hour

	// IncrementHit uses local count for immediate return; batcher writes to Redis async
	count, err := c.IncrementHit(ctx, key, window)
	if err != nil {
		t.Fatalf("IncrementHit: %v", err)
	}
	if count < 1 {
		t.Errorf("IncrementHit count = %d, want >= 1", count)
	}

	// Flush batcher so Redis has the count before GetHitCount
	c.FlushHitBatcher()

	// Verify hit count in Redis
	got, err := c.GetHitCount(ctx, key)
	if err != nil {
		t.Fatalf("GetHitCount: %v", err)
	}
	if got < 1 {
		t.Errorf("GetHitCount = %d, want >= 1", got)
	}

	// IncrementSweepHit (fire-and-forget)
	c.IncrementSweepHit(ctx, key, window)
	c.FlushHitBatcher()

	// Verify sweep hit count
	sweepCount, err := c.GetSweepHitCount(ctx, key)
	if err != nil {
		t.Fatalf("GetSweepHitCount: %v", err)
	}
	if sweepCount < 1 {
		t.Errorf("GetSweepHitCount = %d, want >= 1", sweepCount)
	}
}

func TestRedisCacheIncrementHitMultiple(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	defer mr.Close()

	cfg := config.RedisConfig{
		Mode:    "standalone",
		Address: mr.Addr(),
	}
	c, err := NewRedisCache(cfg, nil)
	if err != nil {
		t.Fatalf("NewRedisCache: %v", err)
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	key := "batch-key"
	window := time.Hour

	// Multiple increments - batcher should coalesce
	for i := 0; i < 5; i++ {
		_, err := c.IncrementHit(ctx, key, window)
		if err != nil {
			t.Fatalf("IncrementHit #%d: %v", i+1, err)
		}
	}

	c.FlushHitBatcher()

	count, err := c.GetHitCount(ctx, key)
	if err != nil {
		t.Fatalf("GetHitCount: %v", err)
	}
	if count != 5 {
		t.Errorf("GetHitCount = %d, want 5", count)
	}
}

func TestRedisCacheReconcileExpiryIndex(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	defer mr.Close()

	cfg := config.RedisConfig{
		Mode:    "standalone",
		Address: mr.Addr(),
	}
	c, err := NewRedisCache(cfg, nil)
	if err != nil {
		t.Fatalf("NewRedisCache: %v", err)
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Add a valid cache entry (creates index entry)
	msg := new(dns.Msg)
	msg.SetQuestion("example.com.", dns.TypeA)
	msg.Response = true
	if err := c.SetWithIndex(ctx, "dns:example.com.:1:1", msg, time.Minute); err != nil {
		t.Fatalf("SetWithIndex: %v", err)
	}

	// Manually add stale index entries (keys that don't exist as cache entries)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	expiryIndex := "dnsmeta:expiry:index"
	now := time.Now()
	for _, name := range []string{"stale-a.com", "stale-b.com", "stale-c.com"} {
		staleKey := "dns:" + name + ".:1:1"
		if err := rdb.ZAdd(ctx, expiryIndex, redis.Z{Score: float64(now.Unix()), Member: staleKey}).Err(); err != nil {
			t.Fatalf("ZAdd: %v", err)
		}
	}

	// Reconcile should remove the 3 stale entries
	removed, err := c.ReconcileExpiryIndex(ctx, 500)
	if err != nil {
		t.Fatalf("ReconcileExpiryIndex: %v", err)
	}
	if removed != 3 {
		t.Errorf("ReconcileExpiryIndex removed = %d, want 3", removed)
	}

	// Index should now only have the valid entry
	cands, err := c.ExpiryCandidates(ctx, now.Add(time.Hour), 10)
	if err != nil {
		t.Fatalf("ExpiryCandidates: %v", err)
	}
	if len(cands) != 1 || cands[0].Key != "dns:example.com.:1:1" {
		t.Errorf("ExpiryCandidates after reconcile = %v, want single example.com entry", cands)
	}
}

func TestRedisCacheEvictToCap(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	defer mr.Close()

	cfg := config.RedisConfig{
		Mode:    "standalone",
		Address: mr.Addr(),
		MaxKeys: 3,
	}
	c, err := NewRedisCache(cfg, nil)
	if err != nil {
		t.Fatalf("NewRedisCache: %v", err)
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	msg := new(dns.Msg)
	msg.SetQuestion("example.com.", dns.TypeA)
	msg.Response = true

	// Add 5 keys so we're over cap (3). EvictToCap should run and evict by oldest + lowest hits.
	keys := []string{"dns:a.example.com.:1:1", "dns:b.example.com.:1:1", "dns:c.example.com.:1:1", "dns:d.example.com.:1:1", "dns:e.example.com.:1:1"}
	for _, k := range keys {
		if err := c.SetWithIndex(ctx, k, msg, 10*time.Minute); err != nil {
			t.Fatalf("SetWithIndex %s: %v", k, err)
		}
	}
	c.FlushHitBatcher()

	// Give b and c higher hit counts so they are kept (eviction order: lowest hits, then oldest)
	_, _ = c.IncrementHit(ctx, "dns:b.example.com.:1:1", time.Hour)
	_, _ = c.IncrementHit(ctx, "dns:c.example.com.:1:1", time.Hour)
	_, _ = c.IncrementHit(ctx, "dns:c.example.com.:1:1", time.Hour)
	c.FlushHitBatcher()

	evicted, err := c.EvictToCap(ctx)
	if err != nil {
		t.Fatalf("EvictToCap: %v", err)
	}
	// Had 5 keys, cap 3 → expect exactly 2 evicted (lowest hits then oldest: a, d)
	if evicted != 2 {
		t.Errorf("EvictToCap: evicted = %d, want 2", evicted)
	}

	stats := c.GetCacheStats()
	if stats.RedisKeys != 3 {
		t.Errorf("after EvictToCap RedisKeys = %d, want 3", stats.RedisKeys)
	}
	// Eviction order: lowest hits first, then oldest. a,d,e have 0 hits (a oldest); b has 1, c has 2. So we evict a and d. Remain: b, c, e.
	remaining := []string{"dns:b.example.com.:1:1", "dns:c.example.com.:1:1", "dns:e.example.com.:1:1"}
	for _, k := range remaining {
		ok, err := c.Exists(ctx, k)
		if err != nil || !ok {
			t.Errorf("expected key %q to remain after eviction (exists=%v, err=%v)", k, ok, err)
		}
	}
	for _, k := range []string{"dns:a.example.com.:1:1", "dns:d.example.com.:1:1"} {
		ok, err := c.Exists(ctx, k)
		if err != nil || ok {
			t.Errorf("expected key %q to be evicted (exists=%v, err=%v)", k, ok, err)
		}
	}
}

func TestRedisCacheEvictToCapDisabled(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	defer mr.Close()

	cfg := config.RedisConfig{Mode: "standalone", Address: mr.Addr(), MaxKeys: 0}
	c, err := NewRedisCache(cfg, nil)
	if err != nil {
		t.Fatalf("NewRedisCache: %v", err)
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	evicted, err := c.EvictToCap(ctx)
	if err != nil {
		t.Fatalf("EvictToCap (maxKeys=0): %v", err)
	}
	if evicted != 0 {
		t.Errorf("EvictToCap (maxKeys=0): evicted = %d, want 0", evicted)
	}
}

func TestRedisCacheEvictToCapAtOrUnderCap(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	defer mr.Close()

	cfg := config.RedisConfig{
		Mode:    "standalone",
		Address: mr.Addr(),
		MaxKeys: 3,
	}
	c, err := NewRedisCache(cfg, nil)
	if err != nil {
		t.Fatalf("NewRedisCache: %v", err)
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	msg := new(dns.Msg)
	msg.SetQuestion("example.com.", dns.TypeA)
	msg.Response = true

	// Exactly at cap: 3 keys, cap 3 → no eviction
	for _, k := range []string{"dns:a.example.com.:1:1", "dns:b.example.com.:1:1", "dns:c.example.com.:1:1"} {
		if err := c.SetWithIndex(ctx, k, msg, 10*time.Minute); err != nil {
			t.Fatalf("SetWithIndex %s: %v", k, err)
		}
	}
	evicted, err := c.EvictToCap(ctx)
	if err != nil {
		t.Fatalf("EvictToCap: %v", err)
	}
	if evicted != 0 {
		t.Errorf("at cap: evicted = %d, want 0", evicted)
	}
	stats := c.GetCacheStats()
	if stats.RedisKeys != 3 {
		t.Errorf("at cap: RedisKeys = %d, want 3", stats.RedisKeys)
	}

	// Under cap: remove one key so we have 2, cap 3 → no eviction
	c.DeleteCacheKey(ctx, "dns:c.example.com.:1:1")
	evicted2, err := c.EvictToCap(ctx)
	if err != nil {
		t.Fatalf("EvictToCap: %v", err)
	}
	if evicted2 != 0 {
		t.Errorf("under cap: evicted = %d, want 0", evicted2)
	}
}

func TestRedisCacheEvictToCapEmptyExpiryIndex(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	defer mr.Close()

	cfg := config.RedisConfig{
		Mode:    "standalone",
		Address: mr.Addr(),
		MaxKeys: 3,
	}
	c, err := NewRedisCache(cfg, nil)
	if err != nil {
		t.Fatalf("NewRedisCache: %v", err)
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	msg := new(dns.Msg)
	msg.SetQuestion("example.com.", dns.TypeA)
	msg.Response = true

	// Add 5 keys via Set (not SetWithIndex) so they are in Redis but NOT in the expiry index.
	// EvictToCap counts dns:* keys (5) and is over cap (3), but ZRange on expiry index returns empty → 0 evicted.
	for _, k := range []string{"dns:p.example.com.:1:1", "dns:q.example.com.:1:1", "dns:r.example.com.:1:1", "dns:s.example.com.:1:1", "dns:t.example.com.:1:1"} {
		if err := c.Set(ctx, k, msg, 10*time.Minute); err != nil {
			t.Fatalf("Set %s: %v", k, err)
		}
	}
	evicted, err := c.EvictToCap(ctx)
	if err != nil {
		t.Fatalf("EvictToCap: %v", err)
	}
	if evicted != 0 {
		t.Errorf("empty expiry index: evicted = %d, want 0 (cannot evict without index)", evicted)
	}
	// All 5 keys should still exist
	stats := c.GetCacheStats()
	if stats.RedisKeys != 5 {
		t.Errorf("empty expiry index: RedisKeys = %d, want 5 (no eviction)", stats.RedisKeys)
	}
}
