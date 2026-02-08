package blocklist

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tternquist/beyond-ads-dns/internal/config"
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

	manager := NewManager(cfg, log.New(io.Discard, "", 0))
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

	manager := NewManager(cfg, log.New(io.Discard, "", 0))
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

	manager := NewManager(cfg, log.New(io.Discard, "", 0))
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
	logger := log.New(&logOutput, "", 0)
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
