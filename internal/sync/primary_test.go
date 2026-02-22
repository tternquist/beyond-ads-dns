package sync

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUpdateTokenLastUsed_EmptyPath(t *testing.T) {
	err := UpdateTokenLastUsed("", "token-1")
	if err != nil {
		t.Fatalf("UpdateTokenLastUsed: %v", err)
	}
}

func TestUpdateTokenLastUsed_EmptyToken(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "override.yaml")
	content := []byte(`
sync:
  tokens:
    - id: t1
      name: Token 1
`)
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatalf("write: %v", err)
	}

	err := UpdateTokenLastUsed(path, "")
	if err != nil {
		t.Fatalf("UpdateTokenLastUsed: %v", err)
	}
}

func TestUpdateTokenLastUsed_FileNotExist(t *testing.T) {
	err := UpdateTokenLastUsed("/nonexistent/path/config.yaml", "token-1")
	if err != nil {
		t.Fatalf("expected nil for missing file, got %v", err)
	}
}

func TestUpdateTokenLastUsed_NoSyncSection(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "override.yaml")
	content := []byte(`
blocklists:
  refresh_interval: 6h
`)
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatalf("write: %v", err)
	}

	err := UpdateTokenLastUsed(path, "token-1")
	if err != nil {
		t.Fatalf("UpdateTokenLastUsed: %v", err)
	}
}

func TestUpdateTokenLastUsed_NoTokens(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "override.yaml")
	content := []byte(`
sync: {}
`)
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatalf("write: %v", err)
	}

	err := UpdateTokenLastUsed(path, "token-1")
	if err != nil {
		t.Fatalf("UpdateTokenLastUsed: %v", err)
	}
}

func TestUpdateTokenLastUsed_TokenNotFound(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "override.yaml")
	content := []byte(`
sync:
  tokens:
    - id: other-token
      name: Other
`)
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatalf("write: %v", err)
	}

	err := UpdateTokenLastUsed(path, "token-1")
	if err != nil {
		t.Fatalf("UpdateTokenLastUsed: %v", err)
	}
}

func TestUpdateTokenLastUsed_UpdatesLastUsed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "override.yaml")
	content := []byte(`
sync:
  tokens:
    - id: token-1
      name: Primary Replica
    - id: token-2
      name: Secondary
`)
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatalf("write: %v", err)
	}

	err := UpdateTokenLastUsed(path, "token-1")
	if err != nil {
		t.Fatalf("UpdateTokenLastUsed: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	// last_used should be added and contain RFC3339 format (e.g. 2025-02-22T...)
	if !strings.Contains(string(data), "last_used") {
		t.Errorf("expected last_used in file, got:\n%s", string(data))
	}
	if !strings.Contains(string(data), "token-1") {
		t.Errorf("expected token-1 preserved, got:\n%s", string(data))
	}
}

func TestUpdateTokenLastUsed_InvalidYAML(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "override.yaml")
	content := []byte("invalid: [")
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatalf("write: %v", err)
	}

	err := UpdateTokenLastUsed(path, "token-1")
	if err == nil {
		t.Fatal("expected error for invalid YAML")
	}
}
