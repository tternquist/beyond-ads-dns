package querystore

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestIsValidPartitionID(t *testing.T) {
	tests := []struct {
		name      string
		partition string
		want      bool
	}{
		{"valid YYYYMMDD", "20240131", true},
		{"valid YYYYMMDDHH", "2024013123", true},
		{"empty", "", false},
		{"too short", "2024013", false},
		{"length 9", "202401311", false},
		{"too long", "202401312345", false},
		{"contains letter", "2024013a", false},
		{"contains hyphen", "2024-013", false},
		// SQL-injection style payloads must be rejected: this validator exists
		// specifically to prevent injection from a crafted ClickHouse response.
		{"injection drop", "1';DROP TABLE x;--", false},
		{"injection quote", "20240131' OR '1'='1", false},
		{"spaces", "2024 131", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isValidPartitionID(tt.partition); got != tt.want {
				t.Errorf("isValidPartitionID(%q) = %v, want %v", tt.partition, got, tt.want)
			}
		})
	}
}

func TestIsSchemaMissing(t *testing.T) {
	tests := []struct {
		name string
		body string
		want bool
	}{
		{"unknown database", "Code: 81. DB::Exception: UNKNOWN_DATABASE", true},
		{"unknown table", "Code: 60. UNKNOWN_TABLE: ...", true},
		{"does not exist", "Table beyond.queries does not exist", true},
		{"unrelated error", "Code: 241. MEMORY_LIMIT_EXCEEDED", false},
		{"empty", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isSchemaMissing(tt.body); got != tt.want {
				t.Errorf("isSchemaMissing(%q) = %v, want %v", tt.body, got, tt.want)
			}
		})
	}
}

// newTestStore builds a ClickHouseStore wired to the given mock server URL
// without running the migration logic in NewClickHouseStore.
func newTestStore(serverURL string, maxSizeMB int) *ClickHouseStore {
	return &ClickHouseStore{
		client:    &http.Client{Timeout: 5 * time.Second},
		baseURL:   serverURL,
		database:  "beyond",
		table:     "queries",
		maxSizeMB: maxSizeMB,
		logger:    slog.New(slog.NewTextHandler(nil, &slog.HandlerOptions{Level: slog.LevelError})),
	}
}

func TestGetTableSizeBytes(t *testing.T) {
	tests := []struct {
		name     string
		status   int
		body     string
		want     int64
		wantErr  bool
	}{
		{"normal size", http.StatusOK, "1048576\n", 1048576, false},
		{"zero", http.StatusOK, "0", 0, false},
		{"empty body means zero", http.StatusOK, "", 0, false},
		{"null marker means zero", http.StatusOK, "\\N", 0, false},
		{"non-numeric body", http.StatusOK, "not-a-number", 0, true},
		{"server error", http.StatusInternalServerError, "boom", 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.status)
				w.Write([]byte(tt.body))
			}))
			defer server.Close()

			store := newTestStore(server.URL, 0)
			got, err := store.getTableSizeBytes()
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got size=%d", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("getTableSizeBytes() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestGetOldestPartition(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		body    string
		want    string
		wantErr bool
	}{
		{"partition returned", http.StatusOK, "2024013100\n", "2024013100", false},
		{"no partitions", http.StatusOK, "", "", false},
		{"server error", http.StatusInternalServerError, "boom", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.status)
				w.Write([]byte(tt.body))
			}))
			defer server.Close()

			store := newTestStore(server.URL, 0)
			got, err := store.getOldestPartition()
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("getOldestPartition() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestEnforceMaxSize_DropsUntilUnderLimit(t *testing.T) {
	var sizeCalls, dropCalls int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("query")
		switch {
		case strings.Contains(query, "sum(bytes_on_disk)"):
			// First check is over the limit, second is under (after a drop).
			n := atomic.AddInt32(&sizeCalls, 1)
			w.WriteHeader(http.StatusOK)
			if n == 1 {
				w.Write([]byte("2097152")) // 2MB > 1MB limit
			} else {
				w.Write([]byte("0")) // under limit, stop
			}
		case strings.Contains(query, "SELECT partition"):
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("2024013100"))
		case strings.Contains(query, "DROP PARTITION"):
			atomic.AddInt32(&dropCalls, 1)
			// Verify the partition was validated/quoted as expected.
			if !strings.Contains(query, "DROP PARTITION '2024013100'") {
				t.Errorf("unexpected drop query: %s", query)
			}
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()

	store := newTestStore(server.URL, 1)
	store.enforceMaxSize()

	if got := atomic.LoadInt32(&dropCalls); got != 1 {
		t.Errorf("expected exactly 1 DROP PARTITION, got %d", got)
	}
}

func TestEnforceMaxSize_NoPartitionToDrop(t *testing.T) {
	var dropCalls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("query")
		switch {
		case strings.Contains(query, "sum(bytes_on_disk)"):
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("2097152")) // always over limit
		case strings.Contains(query, "SELECT partition"):
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("")) // no partition available
		case strings.Contains(query, "DROP PARTITION"):
			atomic.AddInt32(&dropCalls, 1)
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()

	store := newTestStore(server.URL, 1)
	store.enforceMaxSize() // must return without dropping or looping forever

	if got := atomic.LoadInt32(&dropCalls); got != 0 {
		t.Errorf("expected no DROP when no partition available, got %d", got)
	}
}

func TestEnforceMaxSize_RejectsInvalidPartition(t *testing.T) {
	var dropCalls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("query")
		switch {
		case strings.Contains(query, "sum(bytes_on_disk)"):
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("2097152")) // over limit
		case strings.Contains(query, "SELECT partition"):
			w.WriteHeader(http.StatusOK)
			// Crafted/garbage partition id that must be rejected before any DROP.
			w.Write([]byte("1';DROP TABLE queries;--"))
		case strings.Contains(query, "DROP PARTITION"):
			atomic.AddInt32(&dropCalls, 1)
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()

	store := newTestStore(server.URL, 1)
	store.enforceMaxSize()

	if got := atomic.LoadInt32(&dropCalls); got != 0 {
		t.Errorf("invalid partition id must not trigger a DROP, got %d drops", got)
	}
}
