package cache

import (
	"context"
	"time"

	"github.com/miekg/dns"
)

// DNSCache is the interface used by the DNS resolver for cache operations.
// *RedisCache implements this interface. Defining it enables testing with
// mock implementations and potential alternate backends (e.g., memcached).
type DNSCache interface {
	Get(ctx context.Context, key string) (*dns.Msg, error)
	GetWithTTL(ctx context.Context, key string) (*dns.Msg, time.Duration, error)
	Set(ctx context.Context, key string, msg *dns.Msg, ttl time.Duration) error
	SetWithIndex(ctx context.Context, key string, msg *dns.Msg, ttl time.Duration) error
	IncrementHit(ctx context.Context, key string, window time.Duration) (int64, error)
	GetHitCount(ctx context.Context, key string) (int64, error)
	IncrementSweepHit(ctx context.Context, key string, window time.Duration) (int64, error)
	GetSweepHitCount(ctx context.Context, key string) (int64, error)
	FlushHitBatcher()
	TryAcquireRefresh(ctx context.Context, key string, ttl time.Duration) (bool, error)
	ReleaseRefresh(ctx context.Context, key string)
	ExpiryCandidates(ctx context.Context, until time.Time, limit int) ([]ExpiryCandidate, error)
	RemoveFromIndex(ctx context.Context, key string)
	DeleteCacheKey(ctx context.Context, key string)
	Exists(ctx context.Context, key string) (bool, error)
	// BatchCandidateChecks returns Exists and SweepHitCount for each candidate in one or few Redis round-trips.
	// Implementations may pipeline Exists and Get for sweep hit keys where possible.
	BatchCandidateChecks(ctx context.Context, candidates []ExpiryCandidate, sweepHitWindow time.Duration) ([]CandidateCheckResult, error)
	// ReconcileExpiryIndex samples keys from the expiry index and removes entries for non-existent cache keys.
	// Returns the number of stale index entries removed. Call periodically to prevent unbounded index growth.
	ReconcileExpiryIndex(ctx context.Context, sampleSize int) (removed int, err error)
	ClearCache(ctx context.Context) error
	GetCacheStats() CacheStats
	Close() error
	CleanLRUCache() int
}

// Ensure *RedisCache implements DNSCache at compile time.
var _ DNSCache = (*RedisCache)(nil)
