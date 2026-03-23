package blocklist

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/logging"
)

func TestManagerIsBlocked(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ads.example.com\n")
	}))
	defer server.Close()

	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources: []config.BlocklistSource{
			{Name: "test", URL: server.URL},
		},
		Allowlist: []string{"allow.example.com"},
		Denylist:  []string{"deny.example.com"},
	}

	manager := NewManager(cfg, logging.NewDiscardLogger())
	if err := manager.LoadOnce(context.Background()); err != nil {
		t.Fatalf("LoadOnce returned error: %v", err)
	}

	cases := []struct {
		name    string
		blocked bool
	}{
		{name: "ads.example.com", blocked: true},
		{name: "sub.ads.example.com", blocked: true},
		{name: "allow.example.com", blocked: false},
		{name: "sub.allow.example.com", blocked: false},
		{name: "deny.example.com", blocked: true},
	}

	for _, tc := range cases {
		if got := manager.IsBlocked(tc.name); got != tc.blocked {
			t.Fatalf("IsBlocked(%q) = %v, want %v", tc.name, got, tc.blocked)
		}
	}
}

func TestManagerRegexAllowlist(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ads.example.com\n")
	}))
	defer server.Close()

	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources: []config.BlocklistSource{
			{Name: "test", URL: server.URL},
		},
		Allowlist: []string{"/^.*\\.allow\\.example\\.com$/", "exact.example.com"},
		Denylist:  []string{},
	}

	manager := NewManager(cfg, logging.NewDiscardLogger())
	if err := manager.LoadOnce(context.Background()); err != nil {
		t.Fatalf("LoadOnce returned error: %v", err)
	}

	cases := []struct {
		name    string
		blocked bool
	}{
		{name: "ads.example.com", blocked: true}, // in source, not in allowlist
		{name: "sub.allow.example.com", blocked: false}, // matches allowlist regex
		{name: "another.allow.example.com", blocked: false}, // matches allowlist regex
		{name: "exact.example.com", blocked: false}, // exact allowlist match
		{name: "sub.exact.example.com", blocked: false}, // exact match doesn't apply to subdomains, but it's not blocked by source
		{name: "not.allow.example.com", blocked: false}, // matches allowlist regex
		{name: "sub.ads.example.com", blocked: true}, // subdomain of blocked domain
	}

	for _, tc := range cases {
		if got := manager.IsBlocked(tc.name); got != tc.blocked {
			t.Fatalf("IsBlocked(%q) = %v, want %v", tc.name, got, tc.blocked)
		}
	}
}

func TestManagerRegexDenylist(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ads.example.com\n")
	}))
	defer server.Close()

	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources: []config.BlocklistSource{
			{Name: "test", URL: server.URL},
		},
		Allowlist: []string{},
		Denylist:  []string{"/^.*\\.tracker\\.example\\.com$/", "/^ads\\..*\\.com$/"},
	}

	manager := NewManager(cfg, logging.NewDiscardLogger())
	if err := manager.LoadOnce(context.Background()); err != nil {
		t.Fatalf("LoadOnce returned error: %v", err)
	}

	cases := []struct {
		name    string
		blocked bool
	}{
		{name: "sub.tracker.example.com", blocked: true},
		{name: "another.tracker.example.com", blocked: true},
		{name: "ads.example.com", blocked: true},
		{name: "ads.other.com", blocked: true},
		{name: "tracker.example.com", blocked: false}, // regex requires at least one char before tracker
		{name: "example.com", blocked: false},
		{name: "other.example.com", blocked: false},
	}

	for _, tc := range cases {
		if got := manager.IsBlocked(tc.name); got != tc.blocked {
			t.Fatalf("IsBlocked(%q) = %v, want %v", tc.name, got, tc.blocked)
		}
	}
}

func TestManagerInvalidRegex(t *testing.T) {
	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
		Allowlist:       []string{"/[invalid regex/", "valid.example.com"},
		Denylist:        []string{},
	}

	var logOutput strings.Builder
	logger := slog.New(slog.NewTextHandler(&logOutput, &slog.HandlerOptions{Level: slog.LevelDebug}))
	manager := NewManager(cfg, logger)

	// Invalid regex should be logged but not cause a panic
	if manager.allowMatcher == nil {
		t.Fatal("allowMatcher should not be nil")
	}

	// Valid domain should still work
	if manager.IsBlocked("valid.example.com") {
		t.Error("valid.example.com should not be blocked")
	}

	// Invalid regex should be logged
	if !strings.Contains(logOutput.String(), "invalid regex") {
		t.Error("expected log message about invalid regex")
	}
}

func TestManagerApplyConfig(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ads.example.com\n")
	}))
	defer server.Close()

	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{{Name: "test", URL: server.URL}},
		Allowlist:       []string{},
		Denylist:        []string{},
	}
	manager := NewManager(cfg, logging.NewDiscardLogger())
	if err := manager.LoadOnce(context.Background()); err != nil {
		t.Fatalf("LoadOnce: %v", err)
	}

	// Apply same config - should skip reload (no error, LoadOnce not called again for unchanged)
	err := manager.ApplyConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("ApplyConfig same config: %v", err)
	}

	// Apply different config - should reload
	cfg2 := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: 2 * time.Hour},
		Sources:         []config.BlocklistSource{{Name: "test", URL: server.URL}},
		Allowlist:       []string{"allow.example.com"},
		Denylist:        []string{},
	}
	err = manager.ApplyConfig(context.Background(), cfg2)
	if err != nil {
		t.Fatalf("ApplyConfig different config: %v", err)
	}
	if manager.IsBlocked("allow.example.com") {
		t.Error("allow.example.com should not be blocked after ApplyConfig")
	}
}

func TestManagerPauseResume(t *testing.T) {
	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
		Denylist:        []string{"blocked.example.com"},
	}
	manager := NewManager(cfg, logging.NewDiscardLogger())
	manager.LoadOnce(context.Background())

	if !manager.IsBlocked("blocked.example.com") {
		t.Fatal("expected blocked before pause")
	}

	manager.Pause(5 * time.Minute)
	if !manager.IsPaused() {
		t.Error("expected IsPaused true after Pause")
	}
	if manager.IsBlocked("blocked.example.com") {
		t.Error("expected not blocked when paused")
	}

	manager.Resume()
	if manager.IsPaused() {
		t.Error("expected IsPaused false after Resume")
	}
	if !manager.IsBlocked("blocked.example.com") {
		t.Error("expected blocked again after Resume")
	}
}

func TestManagerStats(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ads.example.com\ntracker.example.com\n")
	}))
	defer server.Close()

	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{{Name: "test", URL: server.URL}},
		Allowlist:       []string{"allow.example.com"},
		Denylist:        []string{"deny.example.com"},
	}
	manager := NewManager(cfg, logging.NewDiscardLogger())
	manager.LoadOnce(context.Background())

	stats := manager.Stats()
	if stats.Blocked != 2 {
		t.Errorf("Stats.Blocked = %d, want 2", stats.Blocked)
	}
	if stats.Allow < 1 {
		t.Errorf("Stats.Allow = %d, want >= 1", stats.Allow)
	}
	if stats.Deny < 1 {
		t.Errorf("Stats.Deny = %d, want >= 1", stats.Deny)
	}
}

func TestManagerScheduledPause(t *testing.T) {
	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
		Denylist:        []string{"blocked.example.com"},
		ScheduledPause: &config.ScheduledPauseConfig{
			Enabled: ptr(true),
			Start:   "00:00",
			End:     "23:59",
			Days:    []int{}, // empty = all days
		},
	}
	manager := NewManager(cfg, logging.NewDiscardLogger())
	manager.LoadOnce(context.Background())
	manager.Start(context.Background())

	// Scheduled pause window 00:00-23:59 covers most of the day; blocking should be paused
	if manager.IsBlocked("blocked.example.com") {
		t.Error("expected not blocked when scheduled pause is in window")
	}
}

func TestManagerFamilyTime(t *testing.T) {
	enabled := true
	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
		Allowlist:       []string{},
		Denylist:        []string{},
		FamilyTime: &config.FamilyTimeConfig{
			Enabled:  &enabled,
			Start:    "00:00",
			End:      "23:59",
			Days:     []int{},
			Services: []string{"youtube"},
			Domains:  []string{"custom-block.example.com"},
		},
	}
	manager := NewManager(cfg, logging.NewDiscardLogger())
	manager.LoadOnce(context.Background())
	manager.Start(context.Background())

	// Family time window 00:00-23:59; youtube.com and custom-block.example.com should be blocked
	if !manager.IsBlocked("youtube.com") {
		t.Error("expected youtube.com blocked during family time")
	}
	if !manager.IsBlocked("custom-block.example.com") {
		t.Error("expected custom-block.example.com blocked during family time")
	}
	if manager.IsBlocked("example.com") {
		t.Error("example.com should not be blocked (not in family time domains)")
	}
}

func TestManagerValidateSources(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	enabled := true
	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{{Name: "test", URL: server.URL}},
		HealthCheck: &config.BlocklistHealthCheckConfig{
			Enabled:   &enabled,
			FailOnAny: ptr(false),
		},
	}
	manager := NewManager(cfg, logging.NewDiscardLogger())
	manager.LoadOnce(context.Background())

	results, err := manager.ValidateSources(context.Background())
	if err != nil {
		t.Fatalf("ValidateSources: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if !results[0].OK {
		t.Errorf("expected source OK, got %+v", results[0])
	}
}

func TestManagerLoadOnceFailOnAnyPreservesPreviousSnapshot(t *testing.T) {
	previousServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "old.example.com\n")
	}))
	defer previousServer.Close()

	newServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "new.example.com\n")
	}))
	defer newServer.Close()

	failingServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream error", http.StatusServiceUnavailable)
	}))
	defer failingServer.Close()

	enabled := true
	failOnAny := true
	manager := NewManager(config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{{Name: "previous", URL: previousServer.URL}},
		HealthCheck: &config.BlocklistHealthCheckConfig{
			Enabled:   &enabled,
			FailOnAny: &failOnAny,
		},
	}, logging.NewDiscardLogger())

	if err := manager.LoadOnce(context.Background()); err != nil {
		t.Fatalf("initial LoadOnce: %v", err)
	}
	if !manager.IsBlocked("old.example.com") {
		t.Fatal("expected old.example.com to be blocked after initial load")
	}

	err := manager.ApplyConfig(context.Background(), config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources: []config.BlocklistSource{
			{Name: "new", URL: newServer.URL},
			{Name: "failing", URL: failingServer.URL},
		},
		HealthCheck: &config.BlocklistHealthCheckConfig{
			Enabled:   &enabled,
			FailOnAny: &failOnAny,
		},
	})
	if err == nil {
		t.Fatal("expected ApplyConfig to fail when one source returns non-2xx and fail_on_any=true")
	}
	if !strings.Contains(err.Error(), "returned status") {
		t.Fatalf("expected status error, got %v", err)
	}

	// Failed reloads must not replace the previous snapshot with partial data.
	if !manager.IsBlocked("old.example.com") {
		t.Error("expected old snapshot to remain active after failed reload")
	}
	if manager.IsBlocked("new.example.com") {
		t.Error("did not expect partially loaded source to become active after failed reload")
	}
}

func TestManagerLoadOnceFailOnAnyFalseAllowsPartialLoad(t *testing.T) {
	okServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok.example.com\n")
	}))
	defer okServer.Close()

	failingServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream error", http.StatusBadGateway)
	}))
	defer failingServer.Close()

	enabled := true
	failOnAny := false
	manager := NewManager(config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources: []config.BlocklistSource{
			{Name: "ok", URL: okServer.URL},
			{Name: "failing", URL: failingServer.URL},
		},
		HealthCheck: &config.BlocklistHealthCheckConfig{
			Enabled:   &enabled,
			FailOnAny: &failOnAny,
		},
	}, logging.NewDiscardLogger())

	if err := manager.LoadOnce(context.Background()); err != nil {
		t.Fatalf("LoadOnce should succeed when fail_on_any=false: %v", err)
	}
	if !manager.IsBlocked("ok.example.com") {
		t.Error("expected successful source domains to be loaded")
	}
}

func TestManagerLoadOnceFailOnAnyReturnsParseError(t *testing.T) {
	parseFailServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Repeat("a", 1200)+".example.com\n")
	}))
	defer parseFailServer.Close()

	enabled := true
	failOnAny := true
	manager := NewManager(config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{{Name: "bad-parse", URL: parseFailServer.URL}},
		HealthCheck: &config.BlocklistHealthCheckConfig{
			Enabled:   &enabled,
			FailOnAny: &failOnAny,
		},
	}, logging.NewDiscardLogger())

	err := manager.LoadOnce(context.Background())
	if err == nil {
		t.Fatal("expected LoadOnce error for parse failure when fail_on_any=true")
	}
	if !strings.Contains(err.Error(), "parse failed") {
		t.Fatalf("expected parse failure in error, got %v", err)
	}
}

func TestManagerStart_ExitsOnContextCancel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ads.example.com\n")
	}))
	defer server.Close()

	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{{Name: "test", URL: server.URL}},
	}
	manager := NewManager(cfg, logging.NewDiscardLogger())
	manager.LoadOnce(context.Background())

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		manager.Start(ctx)
		close(done)
	}()

	cancel()
	select {
	case <-done:
		// Start exited
	case <-time.After(3 * time.Second):
		t.Fatal("Start did not exit after context cancel")
	}
}
