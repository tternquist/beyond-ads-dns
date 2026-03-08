package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// configVersion tracks which migrations have been applied.
// Bump when adding new migrations; each migration runs when version < target.
const currentConfigVersion = 2

// RunMigrations reads the override config, applies pending migrations, and writes back if changed.
// Safe to call when override path is empty or file does not exist (no-op).
// Returns nil on success or when no migrations needed.
func RunMigrations(overridePath string) error {
	if overridePath == "" {
		return nil
	}
	data, err := os.ReadFile(overridePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read override for migration: %w", err)
	}
	var m map[string]any
	if err := yaml.Unmarshal(data, &m); err != nil {
		return fmt.Errorf("parse override for migration: %w", err)
	}
	if m == nil {
		m = map[string]any{}
	}
	version := getConfigVersion(m)
	if version >= currentConfigVersion {
		return nil
	}
	for v := version + 1; v <= currentConfigVersion; v++ {
		applyMigration(m, v)
	}
	setConfigVersion(m, currentConfigVersion)
	out, err := yaml.Marshal(m)
	if err != nil {
		return fmt.Errorf("marshal migrated config: %w", err)
	}
	if err := os.WriteFile(overridePath, out, 0600); err != nil {
		return fmt.Errorf("write migrated config: %w", err)
	}
	return nil
}

func getConfigVersion(m map[string]any) int {
	v, ok := m["config_version"]
	if !ok {
		return 0
	}
	switch t := v.(type) {
	case int:
		return t
	case float64:
		return int(t)
	}
	return 0
}

func setConfigVersion(m map[string]any, v int) {
	m["config_version"] = v
}

// applyMigration applies migration N. Returns true if config was modified.
func applyMigration(m map[string]any, n int) bool {
	switch n {
	case 1:
		return migration1WarmTTLFraction(m)
	case 2:
		return migration2RefreshPastAuthTTL(m)
	default:
		return false
	}
}

// migration1WarmTTLFraction adds warm_ttl_fraction: 0.25 when cache.refresh has warm_threshold > 0 and warm_ttl_fraction not set.
func migration1WarmTTLFraction(m map[string]any) bool {
	cache, ok := m["cache"].(map[string]any)
	if !ok {
		return false
	}
	refresh, ok := cache["refresh"].(map[string]any)
	if !ok {
		return false
	}
	if _, has := refresh["warm_ttl_fraction"]; has {
		return false
	}
	warmThr := 0
	switch v := refresh["warm_threshold"].(type) {
	case int:
		warmThr = v
	case float64:
		warmThr = int(v)
	}
	if warmThr <= 0 {
		return false
	}
	refresh["warm_ttl_fraction"] = 0.25
	return true
}

// migration2RefreshPastAuthTTL adds refresh_past_auth_ttl: true when cache.refresh exists and the setting is not present.
func migration2RefreshPastAuthTTL(m map[string]any) bool {
	cache, ok := m["cache"].(map[string]any)
	if !ok {
		return false
	}
	refresh, ok := cache["refresh"].(map[string]any)
	if !ok {
		return false
	}
	if _, has := refresh["refresh_past_auth_ttl"]; has {
		return false
	}
	refresh["refresh_past_auth_ttl"] = true
	return true
}
