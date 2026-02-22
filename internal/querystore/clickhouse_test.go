package querystore

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

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
