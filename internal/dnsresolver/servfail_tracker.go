package dnsresolver

import (
	"sync"
	"time"
)

const servfailMaxEntries = 10000

// servfailTracker manages SERVFAIL backoff state with bounded maps.
// It tracks per-cache-key backoff timers, SERVFAIL counts (for refresh threshold),
// and per-key log rate limiting. All maps are bounded to servfailMaxEntries;
// expired entries are pruned on write and periodically via PruneExpired.
type servfailTracker struct {
	mu      sync.RWMutex
	backoff time.Duration
	// refreshThreshold: stop retrying refresh after this many consecutive SERVFAILs (0 = no limit)
	refreshThreshold int
	// logInterval: rate-limit SERVFAIL log messages per key (0 = no rate limit)
	logInterval time.Duration

	until   map[string]time.Time     // cache key -> backoff expiry
	count   map[string]int           // cache key -> consecutive SERVFAIL count
	lastLog map[string]time.Time     // cache key -> last log time (rate limiting)
}

func newServfailTracker(backoff time.Duration, refreshThreshold int, logInterval time.Duration) *servfailTracker {
	return &servfailTracker{
		backoff:          backoff,
		refreshThreshold: refreshThreshold,
		logInterval:      logInterval,
		until:            make(map[string]time.Time),
		count:            make(map[string]int),
		lastLog:          make(map[string]time.Time),
	}
}

// RecordBackoff sets a backoff timer for the given cache key and prunes expired entries.
// The maps are bounded: if they exceed servfailMaxEntries after pruning, the oldest
// expired entries have already been removed; further growth is unlikely under normal
// conditions since entries expire after the backoff duration.
func (s *servfailTracker) RecordBackoff(cacheKey string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.until[cacheKey] = time.Now().Add(s.backoff)
	s.pruneExpiredLocked()
}

// BackoffUntil returns the backoff expiry time for the given cache key.
// Returns zero time if no backoff is active.
func (s *servfailTracker) BackoffUntil(cacheKey string) time.Time {
	s.mu.RLock()
	until, ok := s.until[cacheKey]
	s.mu.RUnlock()
	if !ok {
		return time.Time{}
	}
	return until
}

// InBackoff returns true if the cache key is currently in backoff.
func (s *servfailTracker) InBackoff(cacheKey string) bool {
	return s.BackoffUntil(cacheKey).After(time.Now())
}

// IncrementCount increments the SERVFAIL counter for a cache key and returns the new count.
func (s *servfailTracker) IncrementCount(cacheKey string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.count[cacheKey]++
	return s.count[cacheKey]
}

// GetCount returns the current SERVFAIL count for a cache key.
func (s *servfailTracker) GetCount(cacheKey string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.count[cacheKey]
}

// ClearCount removes the SERVFAIL count for a cache key (on successful upstream response).
func (s *servfailTracker) ClearCount(cacheKey string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.count, cacheKey)
}

// ExceedsThreshold returns true if the SERVFAIL count for a cache key exceeds the refresh threshold.
// Returns false when threshold is 0 (disabled).
func (s *servfailTracker) ExceedsThreshold(cacheKey string) bool {
	if s.refreshThreshold <= 0 {
		return false
	}
	return s.GetCount(cacheKey) >= s.refreshThreshold
}

// ShouldLog returns true if a SERVFAIL log message should be emitted for this cache key.
// When logInterval > 0, logs are rate-limited to at most once per interval per key.
// Updates the last-log time atomically when returning true.
func (s *servfailTracker) ShouldLog(cacheKey string) bool {
	if s.logInterval <= 0 {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if last, ok := s.lastLog[cacheKey]; ok && now.Sub(last) < s.logInterval {
		return false
	}
	s.lastLog[cacheKey] = now
	return true
}

// PruneExpired removes all expired entries from the tracker maps.
// Safe to call from a background goroutine (e.g., during sweep).
func (s *servfailTracker) PruneExpired() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneExpiredLocked()
}

// pruneExpiredLocked removes expired backoff entries. Caller must hold s.mu.
// When backoff expires, we clear until and lastLog but preserve count so that
// servfail_refresh_threshold is respected across backoff cycles (count persists
// until a successful refresh calls ClearCount).
func (s *servfailTracker) pruneExpiredLocked() {
	now := time.Now()
	for k, until := range s.until {
		if until.Before(now) {
			delete(s.until, k)
			delete(s.lastLog, k)
			// Do not delete count: threshold must persist across backoff expiry
		}
	}
	// Enforce hard cap: if maps still exceed max, remove oldest entries
	if len(s.until) > servfailMaxEntries {
		excess := len(s.until) - servfailMaxEntries
		removed := 0
		for k := range s.until {
			if removed >= excess {
				break
			}
			delete(s.until, k)
			delete(s.lastLog, k)
			delete(s.count, k)
			removed++
		}
	}
	// Clean orphaned count entries not in until map
	if len(s.count) > servfailMaxEntries {
		for k := range s.count {
			if _, exists := s.until[k]; !exists {
				delete(s.count, k)
			}
		}
	}
}

// Size returns the number of tracked entries (for monitoring/testing).
func (s *servfailTracker) Size() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.until)
}
