package errorlog

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPersister_AppendAndEntries(t *testing.T) {
	dir := t.TempDir()
	cfg := PersistenceConfig{
		RetentionDays:  7,
		Directory:      dir,
		FilenamePrefix: "errors",
	}
	p, err := NewPersister(cfg)
	if err != nil {
		t.Fatalf("NewPersister: %v", err)
	}
	defer p.Close()

	if err := p.Append("first error", SeverityError); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if err := p.Append("second warning", SeverityWarning); err != nil {
		t.Fatalf("Append: %v", err)
	}

	entries := p.Entries()
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if entries[0].Message != "first error" {
		t.Errorf("first message = %q", entries[0].Message)
	}
	if entries[1].Message != "second warning" {
		t.Errorf("second message = %q", entries[1].Message)
	}
	if entries[1].Severity != SeverityWarning {
		t.Errorf("second severity = %q, want warning", entries[1].Severity)
	}
	if entries[0].Timestamp == "" || entries[1].Timestamp == "" {
		t.Error("expected timestamps to be set")
	}
}

func TestPersister_LoadFromDisk(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "errors.jsonl")
	// Write a valid entry
	line := `{"message":"loaded error","timestamp":"` + time.Now().UTC().Format(time.RFC3339) + `"}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	cfg := PersistenceConfig{
		RetentionDays:  7,
		Directory:      dir,
		FilenamePrefix: "errors",
	}
	p, err := NewPersister(cfg)
	if err != nil {
		t.Fatalf("NewPersister: %v", err)
	}
	defer p.Close()

	entries := p.Entries()
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry from load, got %d", len(entries))
	}
	if entries[0].Message != "loaded error" {
		t.Errorf("message = %q", entries[0].Message)
	}
}
