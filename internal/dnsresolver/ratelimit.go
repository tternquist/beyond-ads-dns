package dnsresolver

import (
	"sync"
	"time"
)

const (
	rlShardCount = 16
	// rlPruneThreshold bounds shard memory under spoofed-source floods:
	// when a shard map grows past this, expired entries are pruned inline.
	rlPruneThreshold = 4096
)

// clientRateLimiter enforces a per-client-IP query budget over a fixed
// window, protecting the resolver from abusive clients and from being used
// as a UDP amplification reflector. Sharded by IP hash to avoid a global
// mutex on the query hot path.
type clientRateLimiter struct {
	limit  int
	window time.Duration
	shards [rlShardCount]rlShard
}

type rlShard struct {
	mu     sync.Mutex
	counts map[string]*rlEntry
}

type rlEntry struct {
	windowStart time.Time
	count       int
}

func newClientRateLimiter(limit int, window time.Duration) *clientRateLimiter {
	rl := &clientRateLimiter{limit: limit, window: window}
	for i := range rl.shards {
		rl.shards[i].counts = make(map[string]*rlEntry)
	}
	return rl
}

// Allow reports whether the client identified by ip may make another query
// in the current window.
func (rl *clientRateLimiter) Allow(ip string) bool {
	if ip == "" {
		return true
	}
	now := time.Now()
	shard := &rl.shards[hashString(ip)%rlShardCount]
	shard.mu.Lock()
	defer shard.mu.Unlock()
	e := shard.counts[ip]
	if e == nil || now.Sub(e.windowStart) >= rl.window {
		if len(shard.counts) > rlPruneThreshold {
			for k, v := range shard.counts {
				if now.Sub(v.windowStart) >= rl.window {
					delete(shard.counts, k)
				}
			}
		}
		shard.counts[ip] = &rlEntry{windowStart: now, count: 1}
		return true
	}
	e.count++
	return e.count <= rl.limit
}
