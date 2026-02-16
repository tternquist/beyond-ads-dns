package cache

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
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
	c, err := NewRedisCache(cfg)
	if err != nil {
		t.Fatalf("NewRedisCache: %v", err)
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	key := "test-key"
	window := 48 * time.Hour

	// IncrementHit batches and flushes; wait for flush
	count, err := c.IncrementHit(ctx, key, window)
	if err != nil {
		t.Fatalf("IncrementHit: %v", err)
	}
	if count < 1 {
		t.Errorf("IncrementHit count = %d, want >= 1", count)
	}

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
	c, err := NewRedisCache(cfg)
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
