package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
`))

	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	if cfg.Response.Blocked != "nxdomain" {
		t.Fatalf("expected default blocked response nxdomain, got %q", cfg.Response.Blocked)
	}
	if len(cfg.Upstreams) == 0 {
		t.Fatalf("expected default upstreams, got none")
	}
	if cfg.Blocklists.RefreshInterval.Duration != 6*time.Hour {
		t.Fatalf("expected refresh interval 6h, got %v", cfg.Blocklists.RefreshInterval.Duration)
	}
	if cfg.RequestLog.Enabled == nil || *cfg.RequestLog.Enabled {
		t.Fatalf("expected request logging to be disabled by default")
	}
	if cfg.RequestLog.Directory != "logs" {
		t.Fatalf("expected request log directory 'logs', got %q", cfg.RequestLog.Directory)
	}
	if cfg.RequestLog.FilenamePrefix != "dns-requests" {
		t.Fatalf("expected request log prefix 'dns-requests', got %q", cfg.RequestLog.FilenamePrefix)
	}
	if cfg.QueryStore.Enabled == nil || !*cfg.QueryStore.Enabled {
		t.Fatalf("expected query store to be enabled by default")
	}
	if cfg.QueryStore.Address != "http://localhost:8123" {
		t.Fatalf("expected query store address 'http://localhost:8123', got %q", cfg.QueryStore.Address)
	}
	if cfg.QueryStore.Database != "beyond_ads" {
		t.Fatalf("expected query store database 'beyond_ads', got %q", cfg.QueryStore.Database)
	}
	if cfg.QueryStore.Table != "dns_queries" {
		t.Fatalf("expected query store table 'dns_queries', got %q", cfg.QueryStore.Table)
	}
	if cfg.QueryStore.Username != "default" {
		t.Fatalf("expected query store username 'default', got %q", cfg.QueryStore.Username)
	}
	if cfg.Cache.Refresh.Enabled == nil || !*cfg.Cache.Refresh.Enabled {
		t.Fatalf("expected cache refresh to be enabled by default")
	}
	if cfg.Cache.Refresh.HitWindow.Duration != time.Minute {
		t.Fatalf("expected cache refresh hit window 1m, got %v", cfg.Cache.Refresh.HitWindow.Duration)
	}
	if cfg.Cache.Refresh.HotThreshold != 20 {
		t.Fatalf("expected cache refresh hot threshold 20, got %d", cfg.Cache.Refresh.HotThreshold)
	}
	if cfg.Cache.Refresh.MinTTL.Duration != 30*time.Second {
		t.Fatalf("expected cache refresh min ttl 30s, got %v", cfg.Cache.Refresh.MinTTL.Duration)
	}
	if cfg.Cache.Refresh.HotTTL.Duration != 2*time.Minute {
		t.Fatalf("expected cache refresh hot ttl 2m, got %v", cfg.Cache.Refresh.HotTTL.Duration)
	}
	if cfg.Cache.Refresh.ServeStale == nil || !*cfg.Cache.Refresh.ServeStale {
		t.Fatalf("expected cache refresh serve_stale to be enabled by default")
	}
	if cfg.Cache.Refresh.StaleTTL.Duration != 5*time.Minute {
		t.Fatalf("expected cache refresh stale ttl 5m, got %v", cfg.Cache.Refresh.StaleTTL.Duration)
	}
	if cfg.Cache.Refresh.SweepInterval.Duration != 15*time.Second {
		t.Fatalf("expected cache refresh sweep interval 15s, got %v", cfg.Cache.Refresh.SweepInterval.Duration)
	}
	if cfg.Cache.Refresh.SweepWindow.Duration != 2*time.Minute {
		t.Fatalf("expected cache refresh sweep window 2m, got %v", cfg.Cache.Refresh.SweepWindow.Duration)
	}
	if cfg.Cache.Refresh.BatchSize != 200 {
		t.Fatalf("expected cache refresh batch size 200, got %d", cfg.Cache.Refresh.BatchSize)
	}
}

func TestLoadInvalidBlockedResponse(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(`
response:
  blocked: "not-an-ip"
`))

	if _, err := Load(cfgPath); err == nil {
		t.Fatalf("expected error for invalid blocked response")
	}
}

func TestLoadQueryStoreValidation(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(`
query_store:
  enabled: true
  batch_size: -1
`))

	if _, err := Load(cfgPath); err == nil {
		t.Fatalf("expected error for invalid query store batch size")
	}
}

func writeTempConfig(t *testing.T, data []byte) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("failed to write temp config: %v", err)
	}
	return path
}
