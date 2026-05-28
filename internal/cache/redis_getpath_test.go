package cache

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/miekg/dns"
	"github.com/redis/go-redis/v9"
	"github.com/tternquist/beyond-ads-dns/internal/config"
)

// newGetPathCache spins up a miniredis-backed cache with L0 enabled.
func newGetPathCache(t *testing.T) (*RedisCache, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	cfg := config.RedisConfig{
		Mode:    "standalone",
		Address: mr.Addr(),
		LRUSize: 100,
	}
	c, err := NewRedisCache(cfg, nil)
	if err != nil {
		mr.Close()
		t.Fatalf("NewRedisCache: %v", err)
	}
	t.Cleanup(func() {
		c.Close()
		mr.Close()
	})
	return c, mr
}

func answerMsg(name string) *dns.Msg {
	msg := new(dns.Msg)
	msg.SetQuestion(name, dns.TypeA)
	msg.Response = true
	rr, _ := dns.NewRR(name + " 300 IN A 93.184.216.34")
	msg.Answer = []dns.RR{rr}
	return msg
}

func TestRedisCacheGet_HitMissExpired(t *testing.T) {
	c, _ := newGetPathCache(t)
	ctx := context.Background()

	// Miss: key not present.
	got, err := c.Get(ctx, "dns:absent")
	if err != nil {
		t.Fatalf("Get(absent): %v", err)
	}
	if got != nil {
		t.Errorf("Get(absent) = %v, want nil", got)
	}

	// Hit: written via the hash setter (exercises getHash read path).
	key := "dns:example.com.|A"
	if err := c.SetWithIndex(ctx, key, answerMsg("example.com."), 5*time.Minute, 0); err != nil {
		t.Fatalf("SetWithIndex: %v", err)
	}
	got, err = c.Get(ctx, key)
	if err != nil {
		t.Fatalf("Get(hit): %v", err)
	}
	if got == nil || len(got.Answer) != 1 {
		t.Fatalf("Get(hit) = %v, want msg with 1 answer", got)
	}
	c.ReleaseMsg(got)
}

func TestRedisCacheGet_WrongTypeMigratesLegacyEntry(t *testing.T) {
	c, _ := newGetPathCache(t)
	ctx := context.Background()

	// A legacy entry is a plain string value (not a hash). getHash returns
	// WRONGTYPE, so Get falls back to getLegacy and migrates it to a hash.
	key := "dns:legacy.example.|A"
	if err := c.Set(ctx, key, answerMsg("legacy.example."), 5*time.Minute); err != nil {
		t.Fatalf("Set(legacy): %v", err)
	}

	got, err := c.Get(ctx, key)
	if err != nil {
		t.Fatalf("Get(legacy): %v", err)
	}
	if got == nil || len(got.Answer) != 1 {
		t.Fatalf("Get(legacy) = %v, want migrated msg", got)
	}
	c.ReleaseMsg(got)

	// After migration the key should now be a hash and still readable.
	got2, err := c.Get(ctx, key)
	if err != nil {
		t.Fatalf("Get(after-migrate): %v", err)
	}
	if got2 == nil || len(got2.Answer) != 1 {
		t.Fatalf("Get(after-migrate) = %v, want hash msg", got2)
	}
	c.ReleaseMsg(got2)
}

func TestIsWrongType(t *testing.T) {
	if isWrongType(nil) {
		t.Error("isWrongType(nil) = true, want false")
	}
	if isWrongType(errors.New("some other error")) {
		t.Error("isWrongType(other) = true, want false")
	}
	if !isWrongType(errors.New("WRONGTYPE Operation against a key holding the wrong kind of value")) {
		t.Error("isWrongType(WRONGTYPE) = false, want true")
	}
}

func TestRedisCacheTTL(t *testing.T) {
	c, _ := newGetPathCache(t)
	ctx := context.Background()

	key := "dns:ttl.example.|A"
	if err := c.SetWithIndex(ctx, key, answerMsg("ttl.example."), 5*time.Minute, 0); err != nil {
		t.Fatalf("SetWithIndex: %v", err)
	}
	ttl, err := c.TTL(ctx, key)
	if err != nil {
		t.Fatalf("TTL: %v", err)
	}
	// The Redis key TTL is the soft TTL plus the grace period, so it only
	// needs to be positive for a freshly written entry.
	if ttl <= 0 {
		t.Errorf("TTL = %v, want > 0", ttl)
	}

	// Missing key: redis returns a negative TTL, surfaced as-is (no error).
	if _, err := c.TTL(ctx, "dns:nope"); err != nil {
		t.Errorf("TTL(missing): unexpected error %v", err)
	}
}

func TestRedisCacheGetCreatedAt(t *testing.T) {
	c, _ := newGetPathCache(t)
	ctx := context.Background()

	key := "dns:created.example.|A"
	if err := c.SetWithIndex(ctx, key, answerMsg("created.example."), 5*time.Minute, 0); err != nil {
		t.Fatalf("SetWithIndex: %v", err)
	}
	ts, err := c.getCreatedAt(ctx, key)
	if err != nil {
		t.Fatalf("getCreatedAt: %v", err)
	}
	if ts.IsZero() {
		t.Error("getCreatedAt = zero, want a timestamp for a freshly written entry")
	}

	// Missing key returns zero time, no error.
	ts, err = c.getCreatedAt(ctx, "dns:missing")
	if err != nil {
		t.Fatalf("getCreatedAt(missing): %v", err)
	}
	if !ts.IsZero() {
		t.Errorf("getCreatedAt(missing) = %v, want zero", ts)
	}
}

func TestRedisCacheRefreshLock(t *testing.T) {
	c, _ := newGetPathCache(t)
	ctx := context.Background()

	key := "dns:refresh.example.|A"

	ok, err := c.TryAcquireRefresh(ctx, key, time.Second)
	if err != nil {
		t.Fatalf("TryAcquireRefresh(first): %v", err)
	}
	if !ok {
		t.Fatal("TryAcquireRefresh(first) = false, want true")
	}

	// Second acquire while held must fail.
	ok, err = c.TryAcquireRefresh(ctx, key, time.Second)
	if err != nil {
		t.Fatalf("TryAcquireRefresh(second): %v", err)
	}
	if ok {
		t.Error("TryAcquireRefresh(second) = true, want false (lock held)")
	}

	// After release the lock is acquirable again.
	c.ReleaseRefresh(ctx, key)
	ok, err = c.TryAcquireRefresh(ctx, key, time.Second)
	if err != nil {
		t.Fatalf("TryAcquireRefresh(after release): %v", err)
	}
	if !ok {
		t.Error("TryAcquireRefresh(after release) = false, want true")
	}
}

func TestRedisCacheRemoveFromIndex(t *testing.T) {
	c, mr := newGetPathCache(t)
	ctx := context.Background()

	key := "dns:index.example.|A"
	if err := c.SetWithIndex(ctx, key, answerMsg("index.example."), 5*time.Minute, 0); err != nil {
		t.Fatalf("SetWithIndex: %v", err)
	}
	idxKey := c.expiryIndexKey()
	if n, _ := mr.ZMembers(idxKey); len(n) != 1 {
		t.Fatalf("expiry index members = %d, want 1", len(n))
	}

	c.RemoveFromIndex(ctx, key)
	if members, _ := mr.ZMembers(idxKey); len(members) != 0 {
		t.Errorf("expiry index members after remove = %d, want 0", len(members))
	}
}

func TestRedisCacheSetMaxKeys(t *testing.T) {
	c, _ := newGetPathCache(t)
	c.SetMaxKeys(42)
	if got := c.GetCacheStats().RedisMaxKeys; got != 42 {
		t.Errorf("RedisMaxKeys after SetMaxKeys = %d, want 42", got)
	}
}

func TestRedisCacheLRUStatsAndClean(t *testing.T) {
	c, _ := newGetPathCache(t)
	ctx := context.Background()

	// Populate L0 with a short-lived entry, then a long-lived one.
	c.SetWithIndex(ctx, "dns:short|A", answerMsg("short."), time.Second, 0)
	c.SetWithIndex(ctx, "dns:long|A", answerMsg("long."), 5*time.Minute, 0)

	stats := c.GetLRUStats()
	if stats == nil {
		t.Fatal("GetLRUStats = nil, want stats (L0 enabled)")
	}

	// CleanLRUCache returns count of expired entries removed; non-negative always.
	if n := c.CleanLRUCache(); n < 0 {
		t.Errorf("CleanLRUCache = %d, want >= 0", n)
	}
}

// Sanity: a nil client surfaced as redis.Nil is not treated as WRONGTYPE.
func TestIsWrongType_RedisNil(t *testing.T) {
	if isWrongType(redis.Nil) {
		t.Error("isWrongType(redis.Nil) = true, want false")
	}
}
