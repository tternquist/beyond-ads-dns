package requestlog

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNewDailyWriter(t *testing.T) {
	dir := t.TempDir()
	w, err := NewDailyWriter(dir, "test-requests")
	if err != nil {
		t.Fatalf("NewDailyWriter: %v", err)
	}
	if w == nil {
		t.Fatal("expected non-nil writer")
	}
	defer w.Close()

	// Should create a log file for today
	matches, err := filepath.Glob(filepath.Join(dir, "test-requests-*.log"))
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(matches) != 1 {
		t.Errorf("expected 1 log file, got %d: %v", len(matches), matches)
	}
}

func TestNewDailyWriter_DefaultDirAndPrefix(t *testing.T) {
	dir := t.TempDir()
	// Use empty strings to trigger defaults - but we need a valid dir
	w, err := NewDailyWriter(dir, "")
	if err != nil {
		t.Fatalf("NewDailyWriter: %v", err)
	}
	defer w.Close()

	matches, err := filepath.Glob(filepath.Join(dir, "dns-requests-*.log"))
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(matches) != 1 {
		t.Errorf("expected 1 log file with default prefix, got %d", len(matches))
	}
}

func TestDailyWriter_Write(t *testing.T) {
	dir := t.TempDir()
	w, err := NewDailyWriter(dir, "write-test")
	if err != nil {
		t.Fatalf("NewDailyWriter: %v", err)
	}
	defer w.Close()

	n, err := w.Write([]byte("log line 1\n"))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if n != 11 {
		t.Errorf("Write returned %d, want 11", n)
	}

	n, err = w.Write([]byte("log line 2\n"))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if n != 11 {
		t.Errorf("Write returned %d, want 11", n)
	}

	matches, _ := filepath.Glob(filepath.Join(dir, "write-test-*.log"))
	if len(matches) != 1 {
		t.Fatalf("expected 1 log file, got %d", len(matches))
	}
	data, err := os.ReadFile(matches[0])
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != "log line 1\nlog line 2\n" {
		t.Errorf("unexpected file content: %q", string(data))
	}
}

func TestDailyWriter_Close(t *testing.T) {
	dir := t.TempDir()
	w, err := NewDailyWriter(dir, "close-test")
	if err != nil {
		t.Fatalf("NewDailyWriter: %v", err)
	}

	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Second close should be safe (file is nil)
	if err := w.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestNewDailyWriter_CreatesDir(t *testing.T) {
	dir := t.TempDir()
	subdir := filepath.Join(dir, "nested", "logs")
	w, err := NewDailyWriter(subdir, "nested")
	if err != nil {
		t.Fatalf("NewDailyWriter: %v", err)
	}
	defer w.Close()

	if _, err := os.Stat(subdir); os.IsNotExist(err) {
		t.Error("NewDailyWriter should create directory")
	}
}
