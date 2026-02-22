package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadOverrideMap_EmptyPath(t *testing.T) {
	m, err := ReadOverrideMap("")
	if err != nil {
		t.Fatalf("ReadOverrideMap: %v", err)
	}
	if m == nil {
		t.Fatal("expected non-nil map")
	}
	if len(m) != 0 {
		t.Errorf("expected empty map, got %d keys", len(m))
	}
}

func TestReadOverrideMap_NotExist(t *testing.T) {
	m, err := ReadOverrideMap("/nonexistent/path/override.yaml")
	if err != nil {
		t.Fatalf("ReadOverrideMap: %v", err)
	}
	if m == nil {
		t.Fatal("expected non-nil map")
	}
	if len(m) != 0 {
		t.Errorf("expected empty map for missing file, got %d keys", len(m))
	}
}

func TestReadOverrideMap_ValidFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "override.yaml")
	content := []byte(`
blocklists:
  refresh_interval: 12h
upstreams:
  - address: 8.8.8.8:53
`)
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatalf("write file: %v", err)
	}

	m, err := ReadOverrideMap(path)
	if err != nil {
		t.Fatalf("ReadOverrideMap: %v", err)
	}
	if m == nil {
		t.Fatal("expected non-nil map")
	}
	if bl, ok := m["blocklists"].(map[string]any); !ok || bl["refresh_interval"] != "12h" {
		t.Errorf("unexpected blocklists: %v", m["blocklists"])
	}
	if ups, ok := m["upstreams"].([]any); !ok || len(ups) != 1 {
		t.Errorf("unexpected upstreams: %v", m["upstreams"])
	}
}

func TestReadOverrideMap_InvalidYAML(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "override.yaml")
	content := []byte("invalid: yaml: [")
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatalf("write file: %v", err)
	}

	_, err := ReadOverrideMap(path)
	if err == nil {
		t.Fatal("expected error for invalid YAML")
	}
}

func TestReadOverrideMap_ReadError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "override.yaml")
	if err := os.MkdirAll(path, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// path is now a directory, ReadFile will fail with a different error
	_, err := ReadOverrideMap(path)
	if err == nil {
		t.Fatal("expected error when reading directory as file")
	}
}

func TestWriteOverrideMap_EmptyPath(t *testing.T) {
	err := WriteOverrideMap("", map[string]any{"key": "value"})
	if err == nil {
		t.Fatal("expected error for empty path")
	}
}

func TestWriteOverrideMap_ValidFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "subdir", "override.yaml")
	m := map[string]any{
		"blocklists": map[string]any{"refresh_interval": "6h"},
		"server":     map[string]any{"listen": []any{"127.0.0.1:53"}},
	}

	if err := WriteOverrideMap(path, m); err != nil {
		t.Fatalf("WriteOverrideMap: %v", err)
	}

	// Verify by reading back
	got, err := ReadOverrideMap(path)
	if err != nil {
		t.Fatalf("ReadOverrideMap: %v", err)
	}
	if bl, ok := got["blocklists"].(map[string]any); !ok || bl["refresh_interval"] != "6h" {
		t.Errorf("unexpected blocklists: %v", got["blocklists"])
	}
}

func TestWriteOverrideMap_CreatesDir(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "dir", "override.yaml")
	m := map[string]any{"key": "value"}

	if err := WriteOverrideMap(path, m); err != nil {
		t.Fatalf("WriteOverrideMap: %v", err)
	}
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Fatal("file was not created")
	}
}
