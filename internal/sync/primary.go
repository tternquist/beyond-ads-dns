package sync

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gopkg.in/yaml.v3"
)

// UpdateTokenLastUsed updates the last_used timestamp for the given sync token
// in the primary's override config. Called when a replica successfully pulls config.
func UpdateTokenLastUsed(configPath, tokenID string) error {
	if configPath == "" || tokenID == "" {
		return nil
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read config: %w", err)
	}
	var m map[string]any
	if err := yaml.Unmarshal(data, &m); err != nil {
		return fmt.Errorf("parse config: %w", err)
	}
	if m == nil {
		return nil
	}
	syncVal, ok := m["sync"]
	if !ok || syncVal == nil {
		return nil
	}
	syncMap, ok := syncVal.(map[string]any)
	if !ok {
		return nil
	}
	tokensVal, ok := syncMap["tokens"]
	if !ok || tokensVal == nil {
		return nil
	}
	tokens, ok := tokensVal.([]any)
	if !ok {
		return nil
	}
	now := time.Now().UTC().Format(time.RFC3339)
	updated := false
	for _, t := range tokens {
		tok, ok := t.(map[string]any)
		if !ok {
			continue
		}
		if id, _ := tok["id"].(string); id == tokenID {
			tok["last_used"] = now
			updated = true
			break
		}
	}
	if !updated {
		return nil
	}
	dir := filepath.Dir(configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	out, err := yaml.Marshal(m)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	if err := os.WriteFile(configPath, out, 0600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}
