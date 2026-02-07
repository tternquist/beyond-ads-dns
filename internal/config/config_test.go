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
	if cfg.RequestLog.Enabled == nil || !*cfg.RequestLog.Enabled {
		t.Fatalf("expected request logging to be enabled by default")
	}
	if cfg.RequestLog.Directory != "logs" {
		t.Fatalf("expected request log directory 'logs', got %q", cfg.RequestLog.Directory)
	}
	if cfg.RequestLog.FilenamePrefix != "dns-requests" {
		t.Fatalf("expected request log prefix 'dns-requests', got %q", cfg.RequestLog.FilenamePrefix)
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

func writeTempConfig(t *testing.T, data []byte) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("failed to write temp config: %v", err)
	}
	return path
}
