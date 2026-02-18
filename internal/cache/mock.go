package cache

import (
	"context"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/miekg/dns"
)

// MockCache is an in-memory DNSCache implementation for testing.
// It is safe for concurrent use. Optional error injection supports testing error paths.
type MockCache struct {
	mu sync.RWMutex

	// Storage: key -> cached entry
	entries map[string]*mockEntry

	// Expiry index: key -> softExpiry (for ExpiryCandidates)
	expiryIndex map[string]time.Time

	// Hit counts (key suffix for hit/sweep)
	hitCounts   map[string]int64
	sweepCounts map[string]int64

	// Refresh locks: key -> held until ReleaseRefresh
	refreshLocks map[string]struct{}

	// Stats
	hits   uint64
	misses uint64

	// Optional error injection (set before calling cache methods)
	GetErr           error
	GetWithTTLErr    error
	SetErr           error
	SetWithIndexErr  error
	IncrementHitErr  error
	GetHitCountErr   error
	IncrementSweepErr error
	GetSweepHitErr   error
	TryAcquireErr    error
	ExpiryCandidatesErr error
	ExistsErr        error
	ClearCacheErr    error
}

type mockEntry struct {
	msg        *dns.Msg
	softExpiry time.Time
	expiry     time.Time
}

// NewMockCache creates a new MockCache ready for testing.
func NewMockCache() *MockCache {
	return &MockCache{
		entries:       make(map[string]*mockEntry),
		expiryIndex:   make(map[string]time.Time),
		hitCounts:     make(map[string]int64),
		sweepCounts:   make(map[string]int64),
		refreshLocks:  make(map[string]struct{}),
	}
}

// SetEntry pre-populates the cache for testing (e.g. cache hit path).
// Key should match cacheKey format (e.g. "dns:example.com:1:1").
func (m *MockCache) SetEntry(key string, msg *dns.Msg, ttl time.Duration) {
	if msg == nil || ttl <= 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	softExpiry := now.Add(ttl)
	gracePeriod := ttl
	if gracePeriod > time.Hour {
		gracePeriod = time.Hour
	}
	expiry := softExpiry.Add(gracePeriod)
	m.entries[key] = &mockEntry{msg: msg.Copy(), softExpiry: softExpiry, expiry: expiry}
	m.expiryIndex[key] = softExpiry
}

// SetGetErr sets the error to return from Get/GetWithTTL (for error-path testing).
func (m *MockCache) SetGetErr(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.GetErr = err
	m.GetWithTTLErr = err
}

// SetSetErr sets the error to return from Set/SetWithIndex.
func (m *MockCache) SetSetErr(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.SetErr = err
	m.SetWithIndexErr = err
}

// GetHitCountForTest returns the hit count for a key (for assertions).
func (m *MockCache) GetHitCountForTest(key string) int64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.hitCounts["hit:"+key]
}

// GetSweepHitCountForTest returns the sweep hit count for a key.
func (m *MockCache) GetSweepHitCountForTest(key string) int64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sweepCounts["sweep:"+key]
}

// EntryCount returns the number of cached entries (for assertions).
func (m *MockCache) EntryCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.entries)
}

func (m *MockCache) Get(ctx context.Context, key string) (*dns.Msg, error) {
	msg, _, err := m.GetWithTTL(ctx, key)
	if err != nil {
		return nil, err
	}
	return msg, nil
}

func (m *MockCache) GetWithTTL(ctx context.Context, key string) (*dns.Msg, time.Duration, error) {
	m.mu.RLock()
	err := m.GetWithTTLErr
	m.mu.RUnlock()
	if err != nil {
		return nil, 0, err
	}

	m.mu.RLock()
	e, ok := m.entries[key]
	m.mu.RUnlock()
	if !ok || e == nil {
		atomic.AddUint64(&m.misses, 1)
		return nil, 0, nil
	}

	m.mu.RLock()
	now := time.Now()
	if now.After(e.expiry) {
		m.mu.RUnlock()
		atomic.AddUint64(&m.misses, 1)
		return nil, 0, nil
	}
	remaining := e.softExpiry.Sub(now)
	if remaining < 0 {
		remaining = 0
	}
	m.mu.RUnlock()

	atomic.AddUint64(&m.hits, 1)
	return e.msg.Copy(), remaining, nil
}

func (m *MockCache) Set(ctx context.Context, key string, msg *dns.Msg, ttl time.Duration) error {
	return m.SetWithIndex(ctx, key, msg, ttl)
}

func (m *MockCache) SetWithIndex(ctx context.Context, key string, msg *dns.Msg, ttl time.Duration) error {
	m.mu.RLock()
	err := m.SetWithIndexErr
	m.mu.RUnlock()
	if err != nil {
		return err
	}
	if msg == nil || ttl <= 0 {
		return nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	softExpiry := now.Add(ttl)
	gracePeriod := ttl
	if gracePeriod > time.Hour {
		gracePeriod = time.Hour
	}
	expiry := softExpiry.Add(gracePeriod)
	m.entries[key] = &mockEntry{msg: msg.Copy(), softExpiry: softExpiry, expiry: expiry}
	m.expiryIndex[key] = softExpiry
	return nil
}

func (m *MockCache) IncrementHit(ctx context.Context, key string, window time.Duration) (int64, error) {
	m.mu.RLock()
	err := m.IncrementHitErr
	m.mu.RUnlock()
	if err != nil {
		return 0, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	k := "hit:" + key
	m.hitCounts[k]++
	return m.hitCounts[k], nil
}

func (m *MockCache) GetHitCount(ctx context.Context, key string) (int64, error) {
	m.mu.RLock()
	err := m.GetHitCountErr
	m.mu.RUnlock()
	if err != nil {
		return 0, err
	}

	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.hitCounts["hit:"+key], nil
}

func (m *MockCache) IncrementSweepHit(ctx context.Context, key string, window time.Duration) (int64, error) {
	m.mu.RLock()
	err := m.IncrementSweepErr
	m.mu.RUnlock()
	if err != nil {
		return 0, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	k := "sweep:" + key
	m.sweepCounts[k]++
	return m.sweepCounts[k], nil
}

func (m *MockCache) GetSweepHitCount(ctx context.Context, key string) (int64, error) {
	m.mu.RLock()
	err := m.GetSweepHitErr
	m.mu.RUnlock()
	if err != nil {
		return 0, err
	}

	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sweepCounts["sweep:"+key], nil
}

func (m *MockCache) FlushHitBatcher() {}

func (m *MockCache) TryAcquireRefresh(ctx context.Context, key string, ttl time.Duration) (bool, error) {
	m.mu.RLock()
	err := m.TryAcquireErr
	m.mu.RUnlock()
	if err != nil {
		return false, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if _, held := m.refreshLocks[key]; held {
		return false, nil
	}
	m.refreshLocks[key] = struct{}{}
	return true, nil
}

func (m *MockCache) ReleaseRefresh(ctx context.Context, key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.refreshLocks, key)
}

func (m *MockCache) ExpiryCandidates(ctx context.Context, until time.Time, limit int) ([]ExpiryCandidate, error) {
	m.mu.RLock()
	err := m.ExpiryCandidatesErr
	m.mu.RUnlock()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		return nil, nil
	}

	m.mu.RLock()
	defer m.mu.RUnlock()

	type kv struct {
		key   string
		score float64
	}
	var cands []kv
	for k, t := range m.expiryIndex {
		score := float64(t.Unix())
		if score <= float64(until.Unix()) {
			cands = append(cands, kv{k, score})
		}
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].score < cands[j].score })
	if len(cands) > limit {
		cands = cands[:limit]
	}
	result := make([]ExpiryCandidate, len(cands))
	for i, c := range cands {
		result[i] = ExpiryCandidate{Key: c.key, SoftExpiry: time.Unix(int64(c.score), 0)}
	}
	return result, nil
}

func (m *MockCache) RemoveFromIndex(ctx context.Context, key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.expiryIndex, key)
}

func (m *MockCache) DeleteCacheKey(ctx context.Context, key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.entries, key)
	delete(m.expiryIndex, key)
}

func (m *MockCache) Exists(ctx context.Context, key string) (bool, error) {
	m.mu.RLock()
	err := m.ExistsErr
	m.mu.RUnlock()
	if err != nil {
		return false, err
	}

	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.entries[key]
	return ok, nil
}

func (m *MockCache) ClearCache(ctx context.Context) error {
	m.mu.RLock()
	err := m.ClearCacheErr
	m.mu.RUnlock()
	if err != nil {
		return err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	m.entries = make(map[string]*mockEntry)
	m.expiryIndex = make(map[string]time.Time)
	m.hitCounts = make(map[string]int64)
	m.sweepCounts = make(map[string]int64)
	m.refreshLocks = make(map[string]struct{})
	atomic.StoreUint64(&m.hits, 0)
	atomic.StoreUint64(&m.misses, 0)
	return nil
}

func (m *MockCache) GetCacheStats() CacheStats {
	hits := atomic.LoadUint64(&m.hits)
	misses := atomic.LoadUint64(&m.misses)
	total := hits + misses
	hitRate := 0.0
	if total > 0 {
		hitRate = float64(hits) / float64(total) * 100.0
	}
	m.mu.RLock()
	entries := len(m.entries)
	m.mu.RUnlock()
	return CacheStats{
		Hits:     hits,
		Misses:   misses,
		HitRate:  hitRate,
		LRU:      &LRUStats{Entries: entries, MaxEntries: entries},
		RedisKeys: int64(entries),
	}
}

func (m *MockCache) Close() error {
	return nil
}

func (m *MockCache) CleanLRUCache() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	removed := 0
	for k, e := range m.entries {
		if now.After(e.expiry) {
			delete(m.entries, k)
			delete(m.expiryIndex, k)
			removed++
		}
	}
	return removed
}

// Ensure MockCache implements DNSCache at compile time.
var _ DNSCache = (*MockCache)(nil)
