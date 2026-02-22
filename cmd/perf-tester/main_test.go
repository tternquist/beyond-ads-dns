package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFilepathDir(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"/a/b/c.txt", "/a/b"},
		{"/a/b/", "/a/b"},
		{"file.txt", "."},
		{"a/file.txt", "a"},
		{"/single", ""}, // LastIndex("/")=0, path[:0]=""
	}
	for _, tt := range tests {
		got := filepathDir(tt.path)
		if got != tt.want {
			t.Errorf("filepathDir(%q) = %q, want %q", tt.path, got, tt.want)
		}
	}
}

func TestGenerateNames(t *testing.T) {
	names := generateNames(10)
	if len(names) != 10 {
		t.Errorf("generateNames(10) returned %d names", len(names))
	}
	for i, n := range names {
		if n == "" {
			t.Errorf("name[%d] is empty", i)
		}
		if !strings.Contains(n, ".") {
			t.Errorf("name[%d] = %q should contain dots", i, n)
		}
	}
	// Deterministic for same count
	names2 := generateNames(10)
	if len(names2) != 10 {
		t.Errorf("second generateNames(10) returned %d names", len(names2))
	}
	for i := range names {
		if names[i] != names2[i] {
			t.Errorf("generateNames should be deterministic")
			break
		}
	}
}

func TestGenerateNames_Zero(t *testing.T) {
	names := generateNames(0)
	if names != nil {
		t.Errorf("generateNames(0) = %v, want nil", names)
	}
}

func TestGenerateNames_Negative(t *testing.T) {
	names := generateNames(-1)
	if names != nil {
		t.Errorf("generateNames(-1) = %v, want nil", names)
	}
}

func TestShuffle(t *testing.T) {
	names := []string{"a", "b", "c", "d", "e"}
	orig := make([]string, len(names))
	copy(orig, names)
	shuffle(names, 12345)
	// After shuffle, order may or may not change (seed 12345 is deterministic)
	if len(names) != len(orig) {
		t.Errorf("shuffle changed length")
	}
	// Same elements
	seen := make(map[string]bool)
	for _, n := range names {
		seen[n] = true
	}
	for _, n := range orig {
		if !seen[n] {
			t.Errorf("shuffle lost element %q", n)
		}
	}
}

func TestAverage(t *testing.T) {
	tests := []struct {
		values []int64
		want   int64
	}{
		{[]int64{10, 20, 30}, 20},
		{[]int64{100}, 100},
		{[]int64{}, 0},
		{[]int64{1, 2, 3, 4, 5}, 3},
	}
	for _, tt := range tests {
		got := average(tt.values)
		if got != tt.want {
			t.Errorf("average(%v) = %d, want %d", tt.values, got, tt.want)
		}
	}
}

func TestPercentile(t *testing.T) {
	values := []int64{10, 20, 30, 40, 50, 60, 70, 80, 90, 100}
	tests := []struct {
		p    int
		want int64
	}{
		{0, 10},
		{50, 60},  // rank=4.5, index=5
		{100, 100},
		{25, 30},  // rank=2.25, index=2
		{75, 80},  // rank=6.75, index=7
	}
	for _, tt := range tests {
		got := percentile(values, tt.p)
		if got != tt.want {
			t.Errorf("percentile(values, %d) = %d, want %d", tt.p, got, tt.want)
		}
	}
}

func TestPercentile_Empty(t *testing.T) {
	if got := percentile([]int64{}, 50); got != 0 {
		t.Errorf("percentile([], 50) = %d, want 0", got)
	}
}

func TestToMillis(t *testing.T) {
	if got := toMillis(1000); got != 1.0 {
		t.Errorf("toMillis(1000) = %v, want 1.0", got)
	}
	if got := toMillis(500); got != 0.5 {
		t.Errorf("toMillis(500) = %v, want 0.5", got)
	}
}

func TestSortedKeys(t *testing.T) {
	rcodes := map[int]int64{3: 10, 1: 5, 2: 8, 0: 1}
	keys := sortedKeys(rcodes)
	if len(keys) != 4 {
		t.Errorf("sortedKeys returned %d keys", len(keys))
	}
	for i := 1; i < len(keys); i++ {
		if keys[i] <= keys[i-1] {
			t.Errorf("keys not sorted: %v", keys)
		}
	}
}

func TestSortedKeys_Empty(t *testing.T) {
	keys := sortedKeys(map[int]int64{})
	if len(keys) != 0 {
		t.Errorf("sortedKeys(empty) = %v", keys)
	}
}

func TestReadNamesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "names.txt")
	content := "example.com\nads.tracker.com\n# comment\n\nmetrics.example.org\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	names, err := readNamesFile(path)
	if err != nil {
		t.Fatalf("readNamesFile: %v", err)
	}
	if len(names) != 3 {
		t.Errorf("expected 3 names (skip comment and empty), got %d: %v", len(names), names)
	}
	if names[0] != "example.com" || names[1] != "ads.tracker.com" || names[2] != "metrics.example.org" {
		t.Errorf("unexpected names: %v", names)
	}
}

func TestReadNamesFile_NotExist(t *testing.T) {
	_, err := readNamesFile("/nonexistent/path/names.txt")
	if err == nil {
		t.Error("expected error for missing file")
	}
}

func TestWriteNamesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "subdir", "names.txt")
	names := []string{"a.com", "b.com", "c.com"}

	if err := writeNamesFile(path, names); err != nil {
		t.Fatalf("writeNamesFile: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 3 {
		t.Errorf("expected 3 lines, got %d", len(lines))
	}
}

func TestLoadNames_FromFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "names.txt")
	os.WriteFile(path, []byte("x.com\ny.com\n"), 0644)

	opts := options{namesPath: path}
	names, err := loadNames(opts)
	if err != nil {
		t.Fatalf("loadNames: %v", err)
	}
	if len(names) != 2 {
		t.Errorf("expected 2 names, got %d", len(names))
	}
}

func TestLoadNames_Generate(t *testing.T) {
	opts := options{generateCount: 100}
	names, err := loadNames(opts)
	if err != nil {
		t.Fatalf("loadNames: %v", err)
	}
	if len(names) != 100 {
		t.Errorf("expected 100 generated names, got %d", len(names))
	}
}

func TestLoadNames_GenerateAndWrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "out.txt")
	opts := options{generateCount: 5, writeNamesPath: path}

	names, err := loadNames(opts)
	if err != nil {
		t.Fatalf("loadNames: %v", err)
	}
	if len(names) != 5 {
		t.Errorf("expected 5 names, got %d", len(names))
	}
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Error("writeNamesPath file was not created")
	}
}
