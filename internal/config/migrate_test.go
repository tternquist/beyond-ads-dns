package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRunMigrations_EmptyPath(t *testing.T) {
	if err := RunMigrations(""); err != nil {
		t.Fatalf("RunMigrations empty path: %v", err)
	}
}

func TestRunMigrations_NotExist(t *testing.T) {
	if err := RunMigrations("/nonexistent/path/config.yaml"); err != nil {
		t.Fatalf("RunMigrations not exist: %v", err)
	}
}

func TestRunMigrations_AddWarmTTLFraction(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	content := []byte(`cache:
  refresh:
    enabled: true
    warm_threshold: 2
    warm_ttl: "5m"
`)
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if err := RunMigrations(path); err != nil {
		t.Fatalf("RunMigrations: %v", err)
	}
	m, err := ReadOverrideMap(path)
	if err != nil {
		t.Fatalf("ReadOverrideMap: %v", err)
	}
	if v := getConfigVersion(m); v != currentConfigVersion {
		t.Errorf("config_version = %d, want %d", v, currentConfigVersion)
	}
	refresh, ok := m["cache"].(map[string]any)["refresh"].(map[string]any)
	if !ok {
		t.Fatal("no cache.refresh")
	}
	if frac, ok := refresh["warm_ttl_fraction"]; !ok || frac != 0.25 {
		t.Errorf("warm_ttl_fraction = %v, want 0.25", frac)
	}
}

func TestRunMigrations_AlreadyMigrated(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	content := []byte(`config_version: 1
cache:
  refresh:
    warm_threshold: 2
    warm_ttl_fraction: 0.25
`)
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if err := RunMigrations(path); err != nil {
		t.Fatalf("RunMigrations: %v", err)
	}
	m, err := ReadOverrideMap(path)
	if err != nil {
		t.Fatalf("ReadOverrideMap: %v", err)
	}
	refresh := m["cache"].(map[string]any)["refresh"].(map[string]any)
	if frac := refresh["warm_ttl_fraction"]; frac != 0.25 {
		t.Errorf("warm_ttl_fraction changed to %v", frac)
	}
}

func TestRunMigrations_NoWarmThreshold(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	content := []byte(`cache:
  refresh:
    enabled: true
    warm_threshold: 0
`)
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if err := RunMigrations(path); err != nil {
		t.Fatalf("RunMigrations: %v", err)
	}
	m, err := ReadOverrideMap(path)
	if err != nil {
		t.Fatalf("ReadOverrideMap: %v", err)
	}
	refresh, _ := m["cache"].(map[string]any)["refresh"].(map[string]any)
	if _, has := refresh["warm_ttl_fraction"]; has {
		t.Error("should not add warm_ttl_fraction when warm_threshold is 0")
	}
}

func TestRunMigrations_AddRefreshPastAuthTTL(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	content := []byte(`config_version: 1
cache:
  refresh:
    enabled: true
    warm_threshold: 2
    warm_ttl_fraction: 0.25
`)
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if err := RunMigrations(path); err != nil {
		t.Fatalf("RunMigrations: %v", err)
	}
	m, err := ReadOverrideMap(path)
	if err != nil {
		t.Fatalf("ReadOverrideMap: %v", err)
	}
	if v := getConfigVersion(m); v != currentConfigVersion {
		t.Errorf("config_version = %d, want %d", v, currentConfigVersion)
	}
	refresh, ok := m["cache"].(map[string]any)["refresh"].(map[string]any)
	if !ok {
		t.Fatal("no cache.refresh")
	}
	if v, ok := refresh["refresh_past_auth_ttl"]; !ok || v != true {
		t.Errorf("refresh_past_auth_ttl = %v, want true", v)
	}
}
