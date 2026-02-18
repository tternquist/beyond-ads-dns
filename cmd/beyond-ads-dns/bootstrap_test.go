package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRunServer_InvalidConfigPath(t *testing.T) {
	// runServer returns error when config cannot be loaded.
	// Use non-existent default path so config.Load fails before connecting to Redis.
	os.Setenv("DEFAULT_CONFIG_PATH", "/nonexistent/config/default.yaml")
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	err := runServer("/nonexistent/override.yaml")
	if err == nil {
		t.Fatal("expected runServer to return error for invalid config path")
	}
}

func TestRunServer_ConfigLoadFails(t *testing.T) {
	// Create a default config but use invalid override (e.g. invalid YAML)
	defaultPath := filepath.Join(t.TempDir(), "default.yaml")
	if err := os.WriteFile(defaultPath, []byte(`
server:
  listen: ["127.0.0.1:53"]
`), 0o644); err != nil {
		t.Fatalf("write default config: %v", err)
	}
	overridePath := filepath.Join(t.TempDir(), "override.yaml")
	if err := os.WriteFile(overridePath, []byte("invalid: yaml: [unclosed"), 0o644); err != nil {
		t.Fatalf("write override config: %v", err)
	}

	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	err := runServer(overridePath)
	if err == nil {
		t.Fatal("expected runServer to return error for invalid override YAML")
	}
}
