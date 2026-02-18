package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// ReadOverrideMap reads the override config file as a map. Returns empty map if file does not exist.
func ReadOverrideMap(path string) (map[string]any, error) {
	if path == "" {
		return map[string]any{}, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, fmt.Errorf("read override: %w", err)
	}
	var m map[string]any
	if err := yaml.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse override: %w", err)
	}
	if m == nil {
		m = map[string]any{}
	}
	return m, nil
}

// WriteOverrideMap writes the override config file.
func WriteOverrideMap(path string, m map[string]any) error {
	if path == "" {
		return fmt.Errorf("config path not set")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	data, err := yaml.Marshal(m)
	if err != nil {
		return fmt.Errorf("marshal override: %w", err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("write override: %w", err)
	}
	return nil
}
