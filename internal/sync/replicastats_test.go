package sync

import (
	"testing"
)

func intOrFloatEquals(v any, expect int) bool {
	if v == nil {
		return false
	}
	if i, ok := v.(int); ok {
		return i == expect
	}
	if f, ok := v.(float64); ok {
		return f == float64(expect)
	}
	return false
}

func floatEquals(v any, expect float64) bool {
	if v == nil {
		return false
	}
	if f, ok := v.(float64); ok {
		return f == expect
	}
	return false
}

func TestStoreReplicaStats(t *testing.T) {
	// Use a fresh store for isolation (defaultStore is shared, but we're testing the API)
	StoreReplicaStats("token-1", "Replica A", map[string]any{"blocked": 10}, map[string]any{"hits": 100}, nil, nil, nil)

	all := GetAllReplicaStats()
	if len(all) == 0 {
		t.Fatal("expected at least one replica stat")
	}
	var found bool
	for _, e := range all {
		if e.TokenID == "token-1" {
			found = true
			if e.Name != "Replica A" {
				t.Errorf("Name = %q, want Replica A", e.Name)
			}
			if e.Blocklist == nil || !intOrFloatEquals(e.Blocklist["blocked"], 10) {
				t.Errorf("Blocklist = %v", e.Blocklist)
			}
			if e.Cache == nil || !intOrFloatEquals(e.Cache["hits"], 100) {
				t.Errorf("Cache = %v", e.Cache)
			}
			if e.LastUpdated == "" {
				t.Error("LastUpdated should be set")
			}
			break
		}
	}
	if !found {
		t.Errorf("token-1 not found in %v", all)
	}
}

func TestStoreReplicaStats_EmptyTokenIgnored(t *testing.T) {
	StoreReplicaStats("", "Ignored", nil, nil, nil, nil, nil)
	// Empty token should not add a new entry; we can't easily assert that without
	// knowing prior state, but we verify it doesn't panic.
}

func TestStoreReplicaStats_EmptyNameDefaultsToReplica(t *testing.T) {
	StoreReplicaStats("token-default-name", "", nil, nil, nil, nil, nil)

	all := GetAllReplicaStats()
	for _, e := range all {
		if e.TokenID == "token-default-name" {
			if e.Name != "Replica" {
				t.Errorf("empty name should default to Replica, got %q", e.Name)
			}
			return
		}
	}
	t.Error("token-default-name not found")
}

func TestStoreReplicaStatsWithMeta(t *testing.T) {
	StoreReplicaStatsWithMeta("token-meta", "Replica B", "v1.0.0", "2025-01-01T00:00:00Z", "http://stats:8080",
		map[string]any{"allow": 5}, map[string]any{"hit_rate": 0.95},
		map[string]any{"sweeps_24h": 10},
		map[string]any{"total": 1000}, map[string]any{"avg_ms": 5.2})

	all := GetAllReplicaStats()
	for _, e := range all {
		if e.TokenID == "token-meta" {
			if e.Name != "Replica B" {
				t.Errorf("Name = %q, want Replica B", e.Name)
			}
			if e.Release != "v1.0.0" {
				t.Errorf("Release = %q, want v1.0.0", e.Release)
			}
			if e.BuildTime != "2025-01-01T00:00:00Z" {
				t.Errorf("BuildTime = %q", e.BuildTime)
			}
			if e.StatsSourceURL != "http://stats:8080" {
				t.Errorf("StatsSourceURL = %q", e.StatsSourceURL)
			}
			if e.ResponseDistribution == nil || !intOrFloatEquals(e.ResponseDistribution["total"], 1000) {
				t.Errorf("ResponseDistribution = %v", e.ResponseDistribution)
			}
			if e.ResponseTime == nil || !floatEquals(e.ResponseTime["avg_ms"], 5.2) {
				t.Errorf("ResponseTime = %v", e.ResponseTime)
			}
			return
		}
	}
	t.Error("token-meta not found")
}

func TestReplicaStatsStore_StoreOverwrites(t *testing.T) {
	s := &ReplicaStatsStore{byToken: make(map[string]*ReplicaStatsEntry)}
	s.Store("t1", "First", "", "", "", map[string]any{"a": 1}, nil, nil, nil, nil)
	s.Store("t1", "Second", "", "", "", map[string]any{"b": 2}, nil, nil, nil, nil)

	all := s.GetAll()
	if len(all) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(all))
	}
	if all[0].Name != "Second" {
		t.Errorf("Name = %q, want Second", all[0].Name)
	}
	if !intOrFloatEquals(all[0].Blocklist["b"], 2) {
		t.Errorf("Blocklist = %v", all[0].Blocklist)
	}
}

func TestReplicaStatsStore_GetAllReturnsCopy(t *testing.T) {
	s := &ReplicaStatsStore{byToken: make(map[string]*ReplicaStatsEntry)}
	s.Store("t1", "R1", "", "", "", nil, nil, nil, nil, nil)

	a := s.GetAll()
	b := s.GetAll()
	if len(a) != 1 || len(b) != 1 {
		t.Fatalf("expected 1 entry each, got %d and %d", len(a), len(b))
	}
	// Modifying a returned entry should not affect the store
	a[0].Name = "Modified"
	if b[0].Name != "R1" {
		t.Error("GetAll should return a copy; modifying one slice affected the other")
	}
}
