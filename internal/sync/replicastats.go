package sync

import (
	"sync"
	"time"
)

// ReplicaStatsEntry holds stats pushed by a replica.
type ReplicaStatsEntry struct {
	TokenID             string         `json:"token_id"`
	Name                string         `json:"name"`
	LastUpdated         string         `json:"last_updated"`
	Blocklist           map[string]any `json:"blocklist,omitempty"`
	Cache               map[string]any `json:"cache,omitempty"`
	CacheRefresh        map[string]any `json:"cache_refresh,omitempty"`
	ResponseDistribution map[string]any `json:"response_distribution,omitempty"` // outcome -> count
	ResponseTime        map[string]any `json:"response_time,omitempty"`            // p50, p95, p99, avg_ms, count, etc.
}

// ReplicaStatsStore holds stats pushed by replicas (in-memory).
type ReplicaStatsStore struct {
	mu     sync.RWMutex
	byToken map[string]*ReplicaStatsEntry
}

var defaultStore = &ReplicaStatsStore{byToken: make(map[string]*ReplicaStatsEntry)}

// StoreReplicaStats stores stats for the given token. Name is resolved from config.
func StoreReplicaStats(tokenID, name string, blocklist, cache, cacheRefresh map[string]any, responseDistribution, responseTime map[string]any) {
	defaultStore.Store(tokenID, name, blocklist, cache, cacheRefresh, responseDistribution, responseTime)
}

// Store stores stats for the given token.
func (s *ReplicaStatsStore) Store(tokenID, name string, blocklist, cache, cacheRefresh map[string]any, responseDistribution, responseTime map[string]any) {
	if tokenID == "" {
		return
	}
	if name == "" {
		name = "Replica"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.byToken[tokenID] = &ReplicaStatsEntry{
		TokenID:              tokenID,
		Name:                 name,
		LastUpdated:          time.Now().UTC().Format(time.RFC3339),
		Blocklist:            blocklist,
		Cache:                cache,
		CacheRefresh:         cacheRefresh,
		ResponseDistribution: responseDistribution,
		ResponseTime:         responseTime,
	}
}

// GetAll returns all stored replica stats.
func GetAllReplicaStats() []ReplicaStatsEntry {
	return defaultStore.GetAll()
}

// GetAll returns a copy of all stored replica stats.
func (s *ReplicaStatsStore) GetAll() []ReplicaStatsEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ReplicaStatsEntry, 0, len(s.byToken))
	for _, e := range s.byToken {
		out = append(out, *e)
	}
	return out
}
