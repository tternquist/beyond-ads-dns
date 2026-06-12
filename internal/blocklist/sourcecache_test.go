package blocklist

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/logging"
)

func enabledSourceCache(dir string) *config.BlocklistSourceCacheConfig {
	return &config.BlocklistSourceCacheConfig{Enabled: ptr(true), Directory: dir}
}

func TestSourceCacheSaveLoadRoundTrip(t *testing.T) {
	c := newSourceCache(enabledSourceCache(t.TempDir()))
	domains := map[string]struct{}{
		"ads.example.com":     {},
		"tracker.example.net": {},
	}
	if err := c.save("https://lists.example/pro.txt", domains); err != nil {
		t.Fatalf("save: %v", err)
	}
	loaded, savedAt, err := c.load("https://lists.example/pro.txt")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(loaded) != 2 {
		t.Errorf("loaded %d domains, want 2", len(loaded))
	}
	if _, ok := loaded["ads.example.com"]; !ok {
		t.Error("missing ads.example.com in loaded set")
	}
	if savedAt.IsZero() || time.Since(savedAt) > time.Minute {
		t.Errorf("savedAt = %v, want recent", savedAt)
	}
}

func TestSourceCacheLoadMissing(t *testing.T) {
	c := newSourceCache(enabledSourceCache(t.TempDir()))
	if _, _, err := c.load("https://lists.example/never-saved.txt"); err == nil {
		t.Error("expected error for missing cache file")
	}
}

func TestNewSourceCacheDisabled(t *testing.T) {
	if newSourceCache(nil) != nil {
		t.Error("nil config should disable source cache")
	}
	if newSourceCache(&config.BlocklistSourceCacheConfig{Enabled: ptr(false), Directory: "x"}) != nil {
		t.Error("enabled=false should disable source cache")
	}
	if newSourceCache(&config.BlocklistSourceCacheConfig{Enabled: ptr(true)}) != nil {
		t.Error("empty directory should disable source cache")
	}
}

// TestLoadOnceFallsBackToCachedCopy verifies that when a source starts
// failing after a successful load, the last-good cached copy keeps its
// domains in the blocklist.
func TestLoadOnceFallsBackToCachedCopy(t *testing.T) {
	var fail atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte("ads.example.com\ntracker.example.net\n"))
	}))
	defer srv.Close()

	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{{Name: "test", URL: srv.URL}},
		SourceCache:     enabledSourceCache(t.TempDir()),
	}
	mgr := NewManager(cfg, logging.NewDiscardLogger())
	if err := mgr.LoadOnce(context.Background()); err != nil {
		t.Fatalf("initial load: %v", err)
	}
	if !mgr.IsBlocked("ads.example.com") {
		t.Fatal("expected ads.example.com blocked after initial load")
	}

	// Source starts failing: reload must keep the domains via the cache.
	fail.Store(true)
	if err := mgr.LoadOnce(context.Background()); err != nil {
		t.Fatalf("reload with failing source: %v", err)
	}
	if !mgr.IsBlocked("ads.example.com") {
		t.Error("expected ads.example.com still blocked from cached copy")
	}
	if stats := mgr.Stats(); stats.FallbackSources != 1 {
		t.Errorf("FallbackSources = %d, want 1", stats.FallbackSources)
	}
}

// TestLoadOnceFallsBackOnEmptyResponse covers sources that return an HTTP 200
// error page with no parseable domains.
func TestLoadOnceFallsBackOnEmptyResponse(t *testing.T) {
	var empty atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if empty.Load() {
			_, _ = w.Write([]byte("# maintenance page, no domains\n"))
			return
		}
		_, _ = w.Write([]byte("ads.example.com\n"))
	}))
	defer srv.Close()

	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{{Name: "test", URL: srv.URL}},
		SourceCache:     enabledSourceCache(t.TempDir()),
	}
	mgr := NewManager(cfg, logging.NewDiscardLogger())
	if err := mgr.LoadOnce(context.Background()); err != nil {
		t.Fatalf("initial load: %v", err)
	}

	empty.Store(true)
	if err := mgr.LoadOnce(context.Background()); err != nil {
		t.Fatalf("reload with empty source: %v", err)
	}
	if !mgr.IsBlocked("ads.example.com") {
		t.Error("expected ads.example.com still blocked from cached copy after empty response")
	}
}

// TestLoadOnceColdStartFromCache verifies a fresh manager can load entirely
// from cached copies when the network is unavailable (e.g. boot without
// internet).
func TestLoadOnceColdStartFromCache(t *testing.T) {
	dir := t.TempDir()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ads.example.com\n"))
	}))

	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{{Name: "test", URL: srv.URL}},
		SourceCache:     enabledSourceCache(dir),
	}
	mgr := NewManager(cfg, logging.NewDiscardLogger())
	if err := mgr.LoadOnce(context.Background()); err != nil {
		t.Fatalf("initial load: %v", err)
	}
	srv.Close() // network goes away

	fresh := NewManager(cfg, logging.NewDiscardLogger())
	if err := fresh.LoadOnce(context.Background()); err != nil {
		t.Fatalf("cold start load: %v", err)
	}
	if !fresh.IsBlocked("ads.example.com") {
		t.Error("expected cold start to serve domains from cached copy")
	}
}

// TestLoadOnceFailOnAnySkipsFallback: fail_on_any is an explicit strictness
// opt-in; it must fail the reload rather than fall back.
func TestLoadOnceFailOnAnySkipsFallback(t *testing.T) {
	dir := t.TempDir()
	var fail atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte("ads.example.com\n"))
	}))
	defer srv.Close()

	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{{Name: "test", URL: srv.URL}},
		SourceCache:     enabledSourceCache(dir),
		HealthCheck:     &config.BlocklistHealthCheckConfig{FailOnAny: ptr(true)},
	}
	mgr := NewManager(cfg, logging.NewDiscardLogger())
	if err := mgr.LoadOnce(context.Background()); err != nil {
		t.Fatalf("initial load: %v", err)
	}
	fail.Store(true)
	if err := mgr.LoadOnce(context.Background()); err == nil {
		t.Error("expected error with fail_on_any=true even when cache exists")
	}
	// Previous snapshot is retained on failure.
	if !mgr.IsBlocked("ads.example.com") {
		t.Error("expected previous snapshot retained after failed reload")
	}
}

// TestLoadOnceAllSourcesFailNoCache preserves the existing contract: when
// every source fails and no cache exists, LoadOnce errors and keeps the
// previous snapshot.
func TestLoadOnceAllSourcesFailNoCache(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{{Name: "test", URL: srv.URL}},
		SourceCache:     enabledSourceCache(t.TempDir()),
	}
	mgr := NewManager(cfg, logging.NewDiscardLogger())
	if err := mgr.LoadOnce(context.Background()); err == nil {
		t.Error("expected error when all sources fail with no cached copies")
	}
}
