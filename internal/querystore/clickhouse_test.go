package querystore

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIsRetriableConnectionError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"EOF", io.EOF, true},
		{"connection refused", errors.New("connection refused"), true},
		{"connection reset", errors.New("connection reset by peer"), true},
		{"broken pipe", errors.New("write: broken pipe"), true},
		{"use of closed", errors.New("use of closed network connection"), true},
		{"write error", errors.New("write: connection reset"), true},
		{"other error", errors.New("some other error"), false},
		{"context deadline exceeded", errors.New("context deadline exceeded"), true},
		{"i/o timeout", errors.New("dial tcp 127.0.0.1:8123: i/o timeout"), true},
		{"no such host", errors.New("lookup clickhouse: no such host"), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isRetriableConnectionError(tt.err)
			if got != tt.want {
				t.Errorf("isRetriableConnectionError(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

func TestNewClickHouseStore_MockServer(t *testing.T) {
	// Mock ClickHouse HTTP server - returns 200 for all requests
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet && r.URL.Query().Get("query") != "" {
			// migrateToHourlyPartitionsIfNeeded expects empty or \N for no parts
			w.Write([]byte(""))
		}
	}))
	defer server.Close()

	logger := slog.New(slog.NewTextHandler(nil, &slog.HandlerOptions{Level: slog.LevelError}))

	store, err := NewClickHouseStore(
		server.URL,
		"test_db",
		"test_table",
		"",
		"",
		5*time.Second,
		2*time.Second,
		100,
		168, // 7 days retention
		0,   // no max size
		logger,
	)
	if err != nil {
		t.Fatalf("NewClickHouseStore: %v", err)
	}
	defer store.Close()

	// Record an event
	store.Record(Event{
		Timestamp:  time.Now(),
		ClientIP:   "192.168.1.1",
		QName:      "example.com.",
		QType:     "A",
		QClass:    "IN",
		Outcome:   "resolved",
		RCode:     "NOERROR",
		DurationMS: 1.5,
	})

	stats := store.Stats()
	if stats.BufferSize <= 0 {
		t.Errorf("expected positive BufferSize, got %d", stats.BufferSize)
	}
	if stats.TotalRecorded < 1 {
		t.Errorf("expected TotalRecorded >= 1, got %d", stats.TotalRecorded)
	}
}

func TestNewClickHouseStore_EmptyURL(t *testing.T) {
	_, err := NewClickHouseStore("", "db", "table", "", "", time.Second, time.Second, 10, 24, 0, nil)
	if err == nil {
		t.Error("expected error for empty base URL")
	}
}

func TestNewClickHouseStore_Unreachable(t *testing.T) {
	_, err := NewClickHouseStore("http://127.0.0.1:19999", "db", "table", "", "", time.Second, time.Second, 10, 24, 0, nil)
	if err == nil {
		t.Error("expected error for unreachable server")
	}
}

func TestNewClickHouseStore_InvalidIdentifier(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	defer server.Close()

	tests := []struct {
		name     string
		database string
		table    string
		wantErr  string
	}{
		{"empty database", "", "table", "database"},
		{"empty table", "db", "", "table"},
		{"database with hyphen", "my-db", "table", "database"},
		{"table with dot", "db", "my.table", "table"},
		{"database with space", "my db", "table", "database"},
		{"table too long", "db", strings.Repeat("a", 257), "table"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := NewClickHouseStore(server.URL, tt.database, tt.table, "", "", time.Second, time.Second, 10, 24, 0, nil)
			if err == nil {
				t.Fatalf("expected error for invalid identifier")
			}
			if !strings.Contains(err.Error(), tt.wantErr) && !strings.Contains(err.Error(), "alphanumeric") {
				t.Errorf("unexpected error: %v", err)
			}
		})
	}
}
