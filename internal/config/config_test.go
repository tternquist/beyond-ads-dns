package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
`))

	cfg, err := LoadWithFiles(defaultPath, "")
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	if cfg.Response.Blocked != "nxdomain" {
		t.Fatalf("expected default blocked response nxdomain, got %q", cfg.Response.Blocked)
	}
	if cfg.Response.BlockedTTL.Duration != time.Hour {
		t.Fatalf("expected default blocked ttl 1h, got %v", cfg.Response.BlockedTTL.Duration)
	}
	if len(cfg.Upstreams) < 2 {
		t.Fatalf("expected at least 2 default upstreams (primary + secondary), got %d", len(cfg.Upstreams))
	}
	// Verify Google and Quad9 are included for cross-provider fallback
	var hasGoogle, hasQuad9 bool
	for _, u := range cfg.Upstreams {
		if u.Name == "google" && u.Address == "8.8.8.8:53" {
			hasGoogle = true
		}
		if u.Name == "quad9" && u.Address == "9.9.9.9:53" {
			hasQuad9 = true
		}
	}
	if !hasGoogle {
		t.Fatalf("expected default upstreams to include Google (8.8.8.8) as secondary, got %v", cfg.Upstreams)
	}
	if !hasQuad9 {
		t.Fatalf("expected default upstreams to include Quad9 (9.9.9.9) as tertiary, got %v", cfg.Upstreams)
	}
	if cfg.Blocklists.RefreshInterval.Duration != 6*time.Hour {
		t.Fatalf("expected refresh interval 6h, got %v", cfg.Blocklists.RefreshInterval.Duration)
	}
	if cfg.Cache.MinTTL.Duration != 5*time.Minute {
		t.Fatalf("expected cache min ttl 5m, got %v", cfg.Cache.MinTTL.Duration)
	}
	if cfg.Server.ReusePort == nil || !*cfg.Server.ReusePort {
		t.Fatalf("expected reuse_port true by default")
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
	if cfg.QueryStore.Username != "beyondads" {
		t.Fatalf("expected query store username 'beyondads', got %q", cfg.QueryStore.Username)
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
	if cfg.Cache.Refresh.StaleTTL.Duration != 1*time.Hour {
		t.Fatalf("expected cache refresh stale ttl 1h, got %v", cfg.Cache.Refresh.StaleTTL.Duration)
	}
	if cfg.Cache.Refresh.ExpiredEntryTTL.Duration != 30*time.Second {
		t.Fatalf("expected cache refresh expired_entry_ttl 30s, got %v", cfg.Cache.Refresh.ExpiredEntryTTL.Duration)
	}
	if cfg.Cache.Refresh.SweepInterval.Duration != 15*time.Second {
		t.Fatalf("expected cache refresh sweep interval 15s, got %v", cfg.Cache.Refresh.SweepInterval.Duration)
	}
	if cfg.Cache.Refresh.SweepWindow.Duration != 1*time.Minute {
		t.Fatalf("expected cache refresh sweep window 1m, got %v", cfg.Cache.Refresh.SweepWindow.Duration)
	}
	if cfg.Cache.Refresh.MaxBatchSize != 2000 {
		t.Fatalf("expected cache refresh max batch size 2000, got %d", cfg.Cache.Refresh.MaxBatchSize)
	}
	if cfg.Cache.Refresh.SweepMinHits != 1 {
		t.Fatalf("expected cache refresh sweep min hits 1, got %d", cfg.Cache.Refresh.SweepMinHits)
	}
	if cfg.Cache.Refresh.SweepHitWindow.Duration != 48*time.Hour {
		t.Fatalf("expected cache refresh sweep hit window 48h, got %v", cfg.Cache.Refresh.SweepHitWindow.Duration)
	}
	if cfg.Control.Errors == nil {
		t.Fatalf("expected control.errors to be enabled by default")
	}
	if cfg.Control.Errors.Enabled == nil || !*cfg.Control.Errors.Enabled {
		t.Fatalf("expected control.errors.enabled to be true by default")
	}
	if cfg.Control.Errors.RetentionDays != 7 {
		t.Fatalf("expected control.errors.retention_days 7, got %d", cfg.Control.Errors.RetentionDays)
	}
	if cfg.Control.Errors.Directory != "logs" {
		t.Fatalf("expected control.errors.directory 'logs', got %q", cfg.Control.Errors.Directory)
	}
	if cfg.Control.Errors.FilenamePrefix != "errors" {
		t.Fatalf("expected control.errors.filename_prefix 'errors', got %q", cfg.Control.Errors.FilenamePrefix)
	}
	if cfg.Logging.Level != "warning" {
		t.Fatalf("expected logging.level 'warning', got %q", cfg.Logging.Level)
	}
}

func TestLoadWithOverrides(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
cache:
  min_ttl: "300s"
`))
	overridePath := writeTempConfig(t, []byte(`
cache:
  min_ttl: "600s"
blocklists:
  allowlist: ["example.com"]
`))

	cfg, err := LoadWithFiles(defaultPath, overridePath)
	if err != nil {
		t.Fatalf("LoadWithFiles returned error: %v", err)
	}
	if cfg.Cache.MinTTL.Duration != 10*time.Minute {
		t.Fatalf("expected cache min ttl 10m, got %v", cfg.Cache.MinTTL.Duration)
	}
	if len(cfg.Blocklists.Allowlist) != 1 || cfg.Blocklists.Allowlist[0] != "example.com" {
		t.Fatalf("expected allowlist override to apply")
	}
}

func TestLoadRedisEnvOverride(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
cache:
  redis:
    address: "redis:6379"
`))

	t.Run("REDIS_ADDRESS", func(t *testing.T) {
		os.Setenv("REDIS_ADDRESS", "redis-node-1:6379")
		defer os.Unsetenv("REDIS_ADDRESS")
		os.Unsetenv("REDIS_URL")

		cfg, err := LoadWithFiles(defaultPath, "")
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.Cache.Redis.Address != "redis-node-1:6379" {
			t.Fatalf("expected REDIS_ADDRESS to override address, got %q", cfg.Cache.Redis.Address)
		}
	})

	t.Run("REDIS_URL", func(t *testing.T) {
		os.Unsetenv("REDIS_ADDRESS")
		os.Setenv("REDIS_URL", "redis://my-redis:6380")
		defer os.Unsetenv("REDIS_URL")

		cfg, err := LoadWithFiles(defaultPath, "")
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.Cache.Redis.Address != "my-redis:6380" {
			t.Fatalf("expected REDIS_URL to override address, got %q", cfg.Cache.Redis.Address)
		}
	})

	t.Run("REDIS_ADDRESS takes precedence over REDIS_URL", func(t *testing.T) {
		os.Setenv("REDIS_ADDRESS", "explicit:6379")
		defer os.Unsetenv("REDIS_ADDRESS")
		os.Setenv("REDIS_URL", "redis://from-url:6379")
		defer os.Unsetenv("REDIS_URL")

		cfg, err := LoadWithFiles(defaultPath, "")
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.Cache.Redis.Address != "explicit:6379" {
			t.Fatalf("expected REDIS_ADDRESS to take precedence, got %q", cfg.Cache.Redis.Address)
		}
	})

	t.Run("REDIS_PASSWORD overrides cache.redis.password", func(t *testing.T) {
		os.Unsetenv("REDIS_ADDRESS")
		os.Unsetenv("REDIS_URL")
		os.Setenv("REDIS_PASSWORD", "secret-from-env")
		defer os.Unsetenv("REDIS_PASSWORD")

		cfg, err := LoadWithFiles(defaultPath, "")
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.Cache.Redis.Password != "secret-from-env" {
			t.Fatalf("expected REDIS_PASSWORD to set password, got %q", cfg.Cache.Redis.Password)
		}
	})

	t.Run("REDIS_URL with password sets password when REDIS_PASSWORD unset", func(t *testing.T) {
		os.Unsetenv("REDIS_ADDRESS")
		os.Unsetenv("REDIS_PASSWORD")
		os.Setenv("REDIS_URL", "redis://:urlpass@my-redis:6380")
		defer os.Unsetenv("REDIS_URL")

		cfg, err := LoadWithFiles(defaultPath, "")
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.Cache.Redis.Address != "my-redis:6380" {
			t.Fatalf("expected address from URL, got %q", cfg.Cache.Redis.Address)
		}
		if cfg.Cache.Redis.Password != "urlpass" {
			t.Fatalf("expected password from REDIS_URL, got %q", cfg.Cache.Redis.Password)
		}
	})

	t.Run("REDIS_PASSWORD takes precedence over REDIS_URL password", func(t *testing.T) {
		os.Unsetenv("REDIS_ADDRESS")
		os.Setenv("REDIS_PASSWORD", "env-wins")
		os.Setenv("REDIS_URL", "redis://:urlpass@my-redis:6380")
		defer func() {
			os.Unsetenv("REDIS_PASSWORD")
			os.Unsetenv("REDIS_URL")
		}()

		cfg, err := LoadWithFiles(defaultPath, "")
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.Cache.Redis.Password != "env-wins" {
			t.Fatalf("expected REDIS_PASSWORD to take precedence, got %q", cfg.Cache.Redis.Password)
		}
	})
}

func TestLoadRedisSentinelClusterEnvOverride(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
cache:
  redis:
    address: "redis:6379"
`))

	t.Run("REDIS_MODE sentinel with REDIS_SENTINEL_ADDRS and REDIS_MASTER_NAME", func(t *testing.T) {
		os.Setenv("REDIS_MODE", "sentinel")
		os.Setenv("REDIS_MASTER_NAME", "mymaster")
		os.Setenv("REDIS_SENTINEL_ADDRS", "sentinel1:26379, sentinel2:26379")
		defer func() {
			os.Unsetenv("REDIS_MODE")
			os.Unsetenv("REDIS_MASTER_NAME")
			os.Unsetenv("REDIS_SENTINEL_ADDRS")
		}()

		cfg, err := LoadWithFiles(defaultPath, "")
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.Cache.Redis.Mode != "sentinel" {
			t.Fatalf("expected mode sentinel, got %q", cfg.Cache.Redis.Mode)
		}
		if cfg.Cache.Redis.MasterName != "mymaster" {
			t.Fatalf("expected master_name mymaster, got %q", cfg.Cache.Redis.MasterName)
		}
		if len(cfg.Cache.Redis.SentinelAddrs) != 2 {
			t.Fatalf("expected 2 sentinel addrs, got %v", cfg.Cache.Redis.SentinelAddrs)
		}
		if cfg.Cache.Redis.SentinelAddrs[0] != "sentinel1:26379" || cfg.Cache.Redis.SentinelAddrs[1] != "sentinel2:26379" {
			t.Fatalf("expected sentinel addrs, got %v", cfg.Cache.Redis.SentinelAddrs)
		}
	})

	t.Run("REDIS_MODE cluster with REDIS_CLUSTER_ADDRS", func(t *testing.T) {
		os.Setenv("REDIS_MODE", "cluster")
		os.Setenv("REDIS_CLUSTER_ADDRS", "node1:6379, node2:6379, node3:6379")
		defer func() {
			os.Unsetenv("REDIS_MODE")
			os.Unsetenv("REDIS_CLUSTER_ADDRS")
		}()

		cfg, err := LoadWithFiles(defaultPath, "")
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.Cache.Redis.Mode != "cluster" {
			t.Fatalf("expected mode cluster, got %q", cfg.Cache.Redis.Mode)
		}
		if len(cfg.Cache.Redis.ClusterAddrs) != 3 {
			t.Fatalf("expected 3 cluster addrs, got %v", cfg.Cache.Redis.ClusterAddrs)
		}
		if cfg.Cache.Redis.ClusterAddrs[0] != "node1:6379" || cfg.Cache.Redis.ClusterAddrs[1] != "node2:6379" || cfg.Cache.Redis.ClusterAddrs[2] != "node3:6379" {
			t.Fatalf("expected cluster addrs, got %v", cfg.Cache.Redis.ClusterAddrs)
		}
	})
}

func TestLoadQueryStoreMaxSizeMBEnvOverride(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
cache:
  redis:
    address: "redis:6379"
`))
	overridePath := writeTempConfig(t, []byte(`
query_store:
  enabled: true
`))

	t.Run("QUERY_STORE_MAX_SIZE_MB overrides config", func(t *testing.T) {
		os.Setenv("QUERY_STORE_MAX_SIZE_MB", "200")
		defer os.Unsetenv("QUERY_STORE_MAX_SIZE_MB")

		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.QueryStore.MaxSizeMB != 200 {
			t.Fatalf("expected max_size_mb 200 from env, got %d", cfg.QueryStore.MaxSizeMB)
		}
	})

	t.Run("QUERY_STORE_MAX_SIZE_MB invalid ignored", func(t *testing.T) {
		os.Setenv("QUERY_STORE_MAX_SIZE_MB", "invalid")
		defer os.Unsetenv("QUERY_STORE_MAX_SIZE_MB")

		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.QueryStore.MaxSizeMB != 0 {
			t.Fatalf("expected max_size_mb 0 when env invalid, got %d", cfg.QueryStore.MaxSizeMB)
		}
	})

	t.Run("QUERY_STORE_MAX_SIZE_MB empty not applied", func(t *testing.T) {
		os.Unsetenv("QUERY_STORE_MAX_SIZE_MB")

		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.QueryStore.MaxSizeMB != 0 {
			t.Fatalf("expected max_size_mb 0 when env unset, got %d", cfg.QueryStore.MaxSizeMB)
		}
	})

	t.Run("QUERY_STORE_PASSWORD overrides query_store.password", func(t *testing.T) {
		os.Setenv("QUERY_STORE_PASSWORD", "secret-from-env")
		defer os.Unsetenv("QUERY_STORE_PASSWORD")

		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.QueryStore.Password != "secret-from-env" {
			t.Fatalf("expected QUERY_STORE_PASSWORD to set password, got %q", cfg.QueryStore.Password)
		}
	})
}

func TestLoadQueryStoreClickHouseEnabledEnv(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
cache:
  redis:
    address: "redis:6379"
`))
	overridePath := writeTempConfig(t, []byte(`
query_store:
  enabled: true
`))

	t.Run("CLICKHOUSE_ENABLED=false disables query store", func(t *testing.T) {
		os.Setenv("CLICKHOUSE_ENABLED", "false")
		defer os.Unsetenv("CLICKHOUSE_ENABLED")

		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.QueryStore.Enabled == nil || *cfg.QueryStore.Enabled {
			t.Fatalf("expected query store disabled when CLICKHOUSE_ENABLED=false, got enabled=%v", cfg.QueryStore.Enabled != nil && *cfg.QueryStore.Enabled)
		}
	})

	t.Run("CLICKHOUSE_ENABLED=0 disables query store", func(t *testing.T) {
		os.Setenv("CLICKHOUSE_ENABLED", "0")
		defer os.Unsetenv("CLICKHOUSE_ENABLED")

		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.QueryStore.Enabled == nil || *cfg.QueryStore.Enabled {
			t.Fatalf("expected query store disabled when CLICKHOUSE_ENABLED=0, got enabled=%v", cfg.QueryStore.Enabled != nil && *cfg.QueryStore.Enabled)
		}
	})

	t.Run("CLICKHOUSE_ENABLED=False (case-insensitive) disables query store", func(t *testing.T) {
		os.Setenv("CLICKHOUSE_ENABLED", "False")
		defer os.Unsetenv("CLICKHOUSE_ENABLED")

		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.QueryStore.Enabled == nil || *cfg.QueryStore.Enabled {
			t.Fatalf("expected query store disabled when CLICKHOUSE_ENABLED=False, got enabled=%v", cfg.QueryStore.Enabled != nil && *cfg.QueryStore.Enabled)
		}
	})

	t.Run("CLICKHOUSE_ENABLED unset leaves query store from config", func(t *testing.T) {
		os.Unsetenv("CLICKHOUSE_ENABLED")

		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.QueryStore.Enabled == nil || !*cfg.QueryStore.Enabled {
			t.Fatalf("expected query store enabled from config when CLICKHOUSE_ENABLED unset, got enabled=%v", cfg.QueryStore.Enabled != nil && *cfg.QueryStore.Enabled)
		}
	})
}

func TestLoadQueryStoreRetentionHours(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
cache:
  redis:
    address: "redis:6379"
`))

	t.Run("retention_hours from config", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
query_store:
  enabled: true
  retention_hours: 12
`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.QueryStore.RetentionHours != 12 {
			t.Fatalf("expected retention_hours 12 from config, got %d", cfg.QueryStore.RetentionHours)
		}
	})

	t.Run("legacy retention_days maps to hours", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
query_store:
  enabled: true
  retention_days: 7
`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.QueryStore.RetentionHours != 168 {
			t.Fatalf("expected retention_hours 168 (7*24) from legacy retention_days, got %d", cfg.QueryStore.RetentionHours)
		}
	})

	t.Run("QUERY_STORE_RETENTION_HOURS overrides config", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
query_store:
  enabled: true
  retention_hours: 6
`))
		os.Setenv("QUERY_STORE_RETENTION_HOURS", "24")
		defer os.Unsetenv("QUERY_STORE_RETENTION_HOURS")

		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.QueryStore.RetentionHours != 24 {
			t.Fatalf("expected retention_hours 24 from env, got %d", cfg.QueryStore.RetentionHours)
		}
	})
}

func TestLoadInvalidBlockedResponse(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
`))
	overridePath := writeTempConfig(t, []byte(`
response:
  blocked: "not-an-ip"
`))

	if _, err := LoadWithFiles(defaultPath, overridePath); err == nil {
		t.Fatalf("expected error for invalid blocked response")
	}
}

func TestLoadQueryStoreValidation(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
`))

	t.Run("batch_size", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
query_store:
  enabled: true
  batch_size: -1
`))
		if _, err := LoadWithFiles(defaultPath, overridePath); err == nil {
			t.Fatalf("expected error for invalid query store batch size")
		}
	})

	t.Run("max_size_mb_negative", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
query_store:
  enabled: true
  max_size_mb: -1
`))
		if _, err := LoadWithFiles(defaultPath, overridePath); err == nil {
			t.Fatalf("expected error for invalid query store max_size_mb")
		}
	})

	t.Run("max_size_mb_zero_valid", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
query_store:
  enabled: true
  max_size_mb: 0
`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.QueryStore.MaxSizeMB != 0 {
			t.Fatalf("expected max_size_mb 0, got %d", cfg.QueryStore.MaxSizeMB)
		}
	})
}

func TestLoadQueryStoreFlushIntervals(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
`))

	t.Run("new fields", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
query_store:
  enabled: true
  flush_to_store_interval: "1m"
  flush_to_disk_interval: "2m"
`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.QueryStore.FlushToStoreInterval.Duration != time.Minute {
			t.Fatalf("expected flush_to_store_interval 1m, got %v", cfg.QueryStore.FlushToStoreInterval.Duration)
		}
		if cfg.QueryStore.FlushToDiskInterval.Duration != 2*time.Minute {
			t.Fatalf("expected flush_to_disk_interval 2m, got %v", cfg.QueryStore.FlushToDiskInterval.Duration)
		}
	})

	t.Run("backward compat flush_interval", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
query_store:
  enabled: true
  flush_interval: "3m"
`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		expected := 3 * time.Minute
		if cfg.QueryStore.FlushToStoreInterval.Duration != expected {
			t.Fatalf("expected flush_to_store_interval 3m from flush_interval, got %v", cfg.QueryStore.FlushToStoreInterval.Duration)
		}
		if cfg.QueryStore.FlushToDiskInterval.Duration != expected {
			t.Fatalf("expected flush_to_disk_interval 3m from flush_interval, got %v", cfg.QueryStore.FlushToDiskInterval.Duration)
		}
	})
}

func TestLoadQueryStoreExclusion(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
cache:
  redis:
    address: "localhost:6379"
`))
	overridePath := writeTempConfig(t, []byte(`
query_store:
  enabled: true
  exclude_domains:
    - localhost
    - local
    - /^internal\\./
  exclude_clients:
    - 192.168.1.10
    - kids-phone
`))
	cfg, err := LoadWithFiles(defaultPath, overridePath)
	if err != nil {
		t.Fatalf("LoadWithFiles: %v", err)
	}
	if len(cfg.QueryStore.ExcludeDomains) != 3 {
		t.Fatalf("expected 3 exclude_domains, got %d: %v", len(cfg.QueryStore.ExcludeDomains), cfg.QueryStore.ExcludeDomains)
	}
	if len(cfg.QueryStore.ExcludeClients) != 2 {
		t.Fatalf("expected 2 exclude_clients, got %d: %v", len(cfg.QueryStore.ExcludeClients), cfg.QueryStore.ExcludeClients)
	}
}

func TestLoadDoTDoHUpstreams(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
`))
	overridePath := writeTempConfig(t, []byte(`
upstreams:
  - name: cloudflare-dot
    address: "tls://1.1.1.1:853"
  - name: cloudflare-doh
    address: "https://cloudflare-dns.com/dns-query"
`))

	cfg, err := LoadWithFiles(defaultPath, overridePath)
	if err != nil {
		t.Fatalf("LoadWithFiles returned error: %v", err)
	}
	if len(cfg.Upstreams) != 2 {
		t.Fatalf("expected 2 upstreams, got %d", len(cfg.Upstreams))
	}
	if cfg.Upstreams[0].Protocol != "tls" || cfg.Upstreams[0].Address != "tls://1.1.1.1:853" {
		t.Fatalf("expected DoT upstream, got protocol=%q address=%q", cfg.Upstreams[0].Protocol, cfg.Upstreams[0].Address)
	}
	if cfg.Upstreams[1].Protocol != "https" || cfg.Upstreams[1].Address != "https://cloudflare-dns.com/dns-query" {
		t.Fatalf("expected DoH upstream, got protocol=%q address=%q", cfg.Upstreams[1].Protocol, cfg.Upstreams[1].Address)
	}
}

func TestLoadDoQUpstream(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
`))
	overridePath := writeTempConfig(t, []byte(`
upstreams:
  - name: cloudflare-doq
    address: "quic://1.1.1.1:853"
`))

	cfg, err := LoadWithFiles(defaultPath, overridePath)
	if err != nil {
		t.Fatalf("LoadWithFiles returned error: %v", err)
	}
	if len(cfg.Upstreams) != 1 {
		t.Fatalf("expected 1 upstream, got %d", len(cfg.Upstreams))
	}
	if cfg.Upstreams[0].Protocol != "quic" || cfg.Upstreams[0].Address != "quic://1.1.1.1:853" {
		t.Fatalf("expected DoQ upstream, got protocol=%q address=%q", cfg.Upstreams[0].Protocol, cfg.Upstreams[0].Address)
	}
}

func TestResolverStrategy(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
`))

	t.Run("default is failover", func(t *testing.T) {
		cfg, err := LoadWithFiles(defaultPath, "")
		if err != nil {
			t.Fatalf("Load returned error: %v", err)
		}
		if cfg.ResolverStrategy != "failover" {
			t.Fatalf("expected default resolver_strategy failover, got %q", cfg.ResolverStrategy)
		}
	})

	t.Run("load_balance valid", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`resolver_strategy: load_balance`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("Load returned error: %v", err)
		}
		if cfg.ResolverStrategy != "load_balance" {
			t.Fatalf("expected resolver_strategy load_balance, got %q", cfg.ResolverStrategy)
		}
	})

	t.Run("weighted valid", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`resolver_strategy: weighted`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("Load returned error: %v", err)
		}
		if cfg.ResolverStrategy != "weighted" {
			t.Fatalf("expected resolver_strategy weighted, got %q", cfg.ResolverStrategy)
		}
	})

	t.Run("invalid strategy rejected", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`resolver_strategy: random`))
		if _, err := LoadWithFiles(defaultPath, overridePath); err == nil {
			t.Fatalf("expected error for invalid resolver_strategy")
		}
	})
}

func TestUpstreamBackoff(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
upstreams:
  - name: test
    address: "1.1.1.1:53"
`))

	t.Run("default 30s when unset", func(t *testing.T) {
		cfg, err := LoadWithFiles(defaultPath, "")
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.Network.UpstreamBackoff == nil || cfg.Network.UpstreamBackoff.Duration != 30*time.Second {
			t.Fatalf("expected default upstream_backoff 30s when unset, got %v", cfg.Network.UpstreamBackoff)
		}
	})

	t.Run("explicit 0 disables", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`upstream_backoff: "0"`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.Network.UpstreamBackoff == nil || cfg.Network.UpstreamBackoff.Duration != 0 {
			t.Fatalf("expected upstream_backoff 0 when disabled, got %v", cfg.Network.UpstreamBackoff)
		}
	})

	t.Run("custom duration", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`upstream_backoff: "60s"`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.Network.UpstreamBackoff == nil || cfg.Network.UpstreamBackoff.Duration != 60*time.Second {
			t.Fatalf("expected upstream_backoff 60s, got %v", cfg.Network.UpstreamBackoff)
		}
	})
}

func TestLoadWebhookContext(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
`))
	overridePath := writeTempConfig(t, []byte(`
webhooks:
  on_block:
    enabled: true
    url: "https://example.com/block"
    context:
      tags: ["production", "dns"]
      environment: "prod"
  on_error:
    enabled: true
    url: "https://example.com/error"
    context:
      tags: ["alerts"]
`))

	cfg, err := LoadWithFiles(defaultPath, overridePath)
	if err != nil {
		t.Fatalf("LoadWithFiles: %v", err)
	}
	if cfg.Webhooks.OnBlock == nil || cfg.Webhooks.OnBlock.Context == nil {
		t.Fatalf("expected on_block context to be set")
	}
	if tags, ok := cfg.Webhooks.OnBlock.Context["tags"].([]any); !ok || len(tags) != 2 {
		t.Fatalf("expected on_block context tags [production dns], got %v", cfg.Webhooks.OnBlock.Context["tags"])
	}
	if cfg.Webhooks.OnBlock.Context["environment"] != "prod" {
		t.Fatalf("expected on_block context environment prod, got %v", cfg.Webhooks.OnBlock.Context["environment"])
	}
	if cfg.Webhooks.OnError == nil || cfg.Webhooks.OnError.Context == nil {
		t.Fatalf("expected on_error context to be set")
	}
	if tags, ok := cfg.Webhooks.OnError.Context["tags"].([]any); !ok || len(tags) != 1 {
		t.Fatalf("expected on_error context tags [alerts], got %v", cfg.Webhooks.OnError.Context["tags"])
	}
	// Rate limit defaults to 60 messages per 1m when unset
	if cfg.Webhooks.OnBlock.RateLimitMaxMessages != 60 {
		t.Fatalf("expected on_block rate_limit_max_messages 60 (default), got %d", cfg.Webhooks.OnBlock.RateLimitMaxMessages)
	}
	if cfg.Webhooks.OnError.RateLimitMaxMessages != 60 {
		t.Fatalf("expected on_error rate_limit_max_messages 60 (default), got %d", cfg.Webhooks.OnError.RateLimitMaxMessages)
	}
}

func TestWebhookRateLimitConfig(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
`))
	t.Run("default 60", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
webhooks:
  on_block:
    enabled: true
    url: "https://example.com/block"
`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.Webhooks.OnBlock.RateLimitMaxMessages != 60 {
			t.Fatalf("expected default 60, got %d", cfg.Webhooks.OnBlock.RateLimitMaxMessages)
		}
		if cfg.Webhooks.OnBlock.RateLimitTimeframe != "1m" {
			t.Fatalf("expected default timeframe 1m, got %q", cfg.Webhooks.OnBlock.RateLimitTimeframe)
		}
	})
	t.Run("explicit unlimited", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
webhooks:
  on_block:
    enabled: true
    url: "https://example.com/block"
    rate_limit_per_minute: -1
`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.Webhooks.OnBlock.RateLimitMaxMessages != -1 {
			t.Fatalf("expected -1 (unlimited), got %d", cfg.Webhooks.OnBlock.RateLimitMaxMessages)
		}
	})
	t.Run("legacy rate_limit_per_minute", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
webhooks:
  on_block:
    enabled: true
    url: "https://example.com/block"
    rate_limit_per_minute: 120
`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.Webhooks.OnBlock.RateLimitMaxMessages != 120 {
			t.Fatalf("expected 120, got %d", cfg.Webhooks.OnBlock.RateLimitMaxMessages)
		}
	})
	t.Run("max_messages and timeframe", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
webhooks:
  on_block:
    enabled: true
    url: "https://example.com/block"
    rate_limit_max_messages: 100
    rate_limit_timeframe: "5m"
`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.Webhooks.OnBlock.RateLimitMaxMessages != 100 {
			t.Fatalf("expected 100, got %d", cfg.Webhooks.OnBlock.RateLimitMaxMessages)
		}
		if cfg.Webhooks.OnBlock.RateLimitTimeframe != "5m" {
			t.Fatalf("expected timeframe 5m, got %q", cfg.Webhooks.OnBlock.RateLimitTimeframe)
		}
	})
}

func TestWebhookMultipleTargets(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
`))
	t.Run("targets array", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
webhooks:
  on_block:
    enabled: true
    targets:
      - url: "https://discord.com/api/webhooks/1/abc"
        target: "discord"
        context:
          env: "prod"
      - url: "https://example.com/webhook"
        target: "default"
`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		targets := cfg.Webhooks.OnBlock.EffectiveTargets()
		if len(targets) != 2 {
			t.Fatalf("expected 2 targets, got %d", len(targets))
		}
		if targets[0].URL != "https://discord.com/api/webhooks/1/abc" || targets[0].Target != "discord" {
			t.Fatalf("expected first target discord, got %v", targets[0])
		}
		if targets[1].URL != "https://example.com/webhook" || targets[1].Target != "default" {
			t.Fatalf("expected second target default, got %v", targets[1])
		}
		if targets[0].Context["env"] != "prod" {
			t.Fatalf("expected context env=prod, got %v", targets[0].Context)
		}
	})
	t.Run("legacy url falls back to single target", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
webhooks:
  on_block:
    enabled: true
    url: "https://legacy.example.com/hook"
    target: "discord"
    context:
      legacy: true
`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		targets := cfg.Webhooks.OnBlock.EffectiveTargets()
		if len(targets) != 1 {
			t.Fatalf("expected 1 target from legacy url, got %d", len(targets))
		}
		if targets[0].URL != "https://legacy.example.com/hook" || targets[0].Target != "discord" {
			t.Fatalf("expected legacy target, got %v", targets[0])
		}
	})
}

func TestReusePortConfig(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
`))

	t.Run("reuse_port valid", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
server:
  reuse_port: true
  reuse_port_listeners: 4
`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		if cfg.Server.ReusePort == nil || !*cfg.Server.ReusePort {
			t.Fatalf("expected reuse_port true")
		}
		if cfg.Server.ReusePortListeners != 4 {
			t.Fatalf("expected reuse_port_listeners 4, got %d", cfg.Server.ReusePortListeners)
		}
	})

	t.Run("reuse_port_listeners out of range rejected", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
server:
  reuse_port: true
  reuse_port_listeners: 100
`))
		if _, err := LoadWithFiles(defaultPath, overridePath); err == nil {
			t.Fatalf("expected error for reuse_port_listeners > 64")
		}
	})
}

func TestClientIdentificationFormats(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
`))

	t.Run("legacy map format", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
client_identification:
  enabled: true
  clients:
    "192.168.1.10": "kids-phone"
    "192.168.1.11": "laptop"
`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		m := cfg.ClientIdentification.Clients.ToNameMap()
		if m["192.168.1.10"] != "kids-phone" || m["192.168.1.11"] != "laptop" {
			t.Fatalf("expected map format to parse, got %v", m)
		}
		if len(cfg.ClientIdentification.Clients.ToGroupMap()) != 0 {
			t.Fatalf("legacy format has no groups")
		}
	})

	t.Run("list format with group_id", func(t *testing.T) {
		overridePath := writeTempConfig(t, []byte(`
client_identification:
  enabled: true
  clients:
    - ip: "192.168.1.10"
      name: "Kids Tablet"
      group_id: "kids"
    - ip: "192.168.1.11"
      name: "Mom's Phone"
      group_id: "adults"
client_groups:
  - id: "kids"
    name: "Kids"
    description: "Children's devices"
  - id: "adults"
    name: "Adults"
`))
		cfg, err := LoadWithFiles(defaultPath, overridePath)
		if err != nil {
			t.Fatalf("LoadWithFiles: %v", err)
		}
		nameMap := cfg.ClientIdentification.Clients.ToNameMap()
		groupMap := cfg.ClientIdentification.Clients.ToGroupMap()
		if nameMap["192.168.1.10"] != "Kids Tablet" || nameMap["192.168.1.11"] != "Mom's Phone" {
			t.Fatalf("expected list format names, got %v", nameMap)
		}
		if groupMap["192.168.1.10"] != "kids" || groupMap["192.168.1.11"] != "adults" {
			t.Fatalf("expected group map, got %v", groupMap)
		}
		if len(cfg.ClientGroups) != 2 {
			t.Fatalf("expected 2 client groups, got %d", len(cfg.ClientGroups))
		}
		if cfg.ClientGroups[0].ID != "kids" || cfg.ClientGroups[0].Name != "Kids" {
			t.Fatalf("expected first group kids, got %v", cfg.ClientGroups[0])
		}
	})

	t.Run("ToNameMap skips entries with missing ip or name", func(t *testing.T) {
		entries := ClientEntries{
			{IP: "1.2.3.4", Name: "valid"},
			{IP: "", Name: "no-ip"},
			{IP: "5.6.7.8", Name: ""},
			{IP: "  ", Name: "whitespace-ip"},
		}
		m := entries.ToNameMap()
		if len(m) != 1 || m["1.2.3.4"] != "valid" {
			t.Fatalf("expected only valid entry, got %v", m)
		}
	})

	t.Run("ToGroupMap skips entries with empty group_id", func(t *testing.T) {
		entries := ClientEntries{
			{IP: "1.2.3.4", Name: "a", GroupID: "g1"},
			{IP: "5.6.7.8", Name: "b", GroupID: ""},
		}
		m := entries.ToGroupMap()
		if len(m) != 1 || m["1.2.3.4"] != "g1" {
			t.Fatalf("expected only entry with group, got %v", m)
		}
	})
}

func TestClientGroup_HasCustomBlocklist(t *testing.T) {
	inheritFalse := false
	inheritTrue := true
	tests := []struct {
		name   string
		group  ClientGroup
		expect bool
	}{
		{"nil blocklist", ClientGroup{ID: "g1"}, false},
		{"inherit_global nil", ClientGroup{Blocklist: &GroupBlocklistConfig{}}, false},
		{"inherit_global true", ClientGroup{Blocklist: &GroupBlocklistConfig{InheritGlobal: &inheritTrue}}, false},
		{"inherit_global false", ClientGroup{Blocklist: &GroupBlocklistConfig{InheritGlobal: &inheritFalse}}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.group.HasCustomBlocklist(); got != tt.expect {
				t.Errorf("HasCustomBlocklist() = %v, want %v", got, tt.expect)
			}
		})
	}
}

func TestClientGroup_GroupBlocklistToConfig(t *testing.T) {
	inheritFalse := false
	refreshInterval := Duration{Duration: time.Hour}
	t.Run("no custom blocklist returns nil", func(t *testing.T) {
		g := ClientGroup{ID: "g1", Blocklist: nil}
		if got := g.GroupBlocklistToConfig(refreshInterval); got != nil {
			t.Errorf("GroupBlocklistToConfig() = %v, want nil", got)
		}
	})
	t.Run("inherit_global false returns config", func(t *testing.T) {
		g := ClientGroup{
			ID: "kids",
			Blocklist: &GroupBlocklistConfig{
				InheritGlobal: &inheritFalse,
				Sources:       []BlocklistSource{{Name: "test", URL: "https://example.com/list.txt"}},
				Denylist:      []string{"bad.com"},
			},
		}
		cfg := g.GroupBlocklistToConfig(refreshInterval)
		if cfg == nil {
			t.Fatal("GroupBlocklistToConfig() = nil, want config")
		}
		if len(cfg.Sources) != 1 || cfg.Sources[0].Name != "test" {
			t.Errorf("Sources = %v", cfg.Sources)
		}
		if len(cfg.Denylist) != 1 || cfg.Denylist[0] != "bad.com" {
			t.Errorf("Denylist = %v", cfg.Denylist)
		}
	})
}

func TestClientGroupsWithBlocklist_YAML(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
`))
	overridePath := writeTempConfig(t, []byte(`
client_groups:
  - id: "kids"
    name: "Kids"
    blocklist:
      inherit_global: false
      sources:
        - name: "hagezi"
          url: "https://example.com/list.txt"
      denylist: ["roblox.com"]
  - id: "adults"
    name: "Adults"
    blocklist:
      inherit_global: true
`))
	cfg, err := LoadWithFiles(defaultPath, overridePath)
	if err != nil {
		t.Fatalf("LoadWithFiles: %v", err)
	}
	if len(cfg.ClientGroups) != 2 {
		t.Fatalf("expected 2 groups, got %d", len(cfg.ClientGroups))
	}
	kids := cfg.ClientGroups[0]
	if !kids.HasCustomBlocklist() {
		t.Error("kids group should have custom blocklist")
	}
	if kids.GroupBlocklistToConfig(cfg.Blocklists.RefreshInterval) == nil {
		t.Error("kids GroupBlocklistToConfig should return config")
	}
	adults := cfg.ClientGroups[1]
	if adults.HasCustomBlocklist() {
		t.Error("adults group should not have custom blocklist (inherit_global: true)")
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
