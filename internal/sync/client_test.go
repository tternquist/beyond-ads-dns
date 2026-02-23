package sync

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/dnsresolver"
	"github.com/tternquist/beyond-ads-dns/internal/localrecords"
	"github.com/tternquist/beyond-ads-dns/internal/logging"
	"github.com/tternquist/beyond-ads-dns/internal/requestlog"
)

func TestNewClient(t *testing.T) {
	blMgr := blocklist.NewManager(config.BlocklistConfig{}, nil)
	client := NewClient(ClientConfig{
		PrimaryURL:   "http://primary:8081/",
		SyncToken:    "token-123",
		Interval:     config.Duration{Duration: 30 * time.Second},
		ConfigPath:   "/tmp/override.yaml",
		DefaultPath:  "/tmp/default.yaml",
		Blocklist:    blMgr,
		LocalRecords: localrecords.New(nil, nil),
		Resolver:     nil,
		Logger:       logging.NewDiscardLogger(),
	})
	if client == nil {
		t.Fatal("NewClient returned nil")
	}
	if client.primaryURL != "http://primary:8081" {
		t.Errorf("primaryURL = %q, want trimmed URL without trailing slash", client.primaryURL)
	}
	if client.syncToken != "token-123" {
		t.Errorf("syncToken = %q", client.syncToken)
	}
	if client.statsSourceURL != "" {
		t.Errorf("statsSourceURL should be empty when not set, got %q", client.statsSourceURL)
	}
}

func TestNewClient_StatsSourceURLTrimmed(t *testing.T) {
	client := NewClient(ClientConfig{
		PrimaryURL:     "http://primary:8081",
		SyncToken:      "token",
		StatsSourceURL: "http://stats:8080/",
		Logger:         logging.NewDiscardLogger(),
	})
	if client.statsSourceURL != "http://stats:8080" {
		t.Errorf("statsSourceURL = %q, want trimmed URL", client.statsSourceURL)
	}
}

// minimalDNSAffectingConfig returns a valid JSON payload for /sync/config.
func minimalDNSAffectingConfig() []byte {
	payload := map[string]any{
		"upstreams": []map[string]any{
			{"name": "doh", "address": "https://dns.example.com/dns-query", "protocol": "https"},
		},
		"resolver_strategy": "failover",
		"blocklists": map[string]any{
			"refresh_interval": "6h",
			"sources":         []any{},
			"allowlist":       []any{},
			"denylist":        []any{},
		},
		"local_records": []any{},
		"response": map[string]any{
			"blocked":     "nxdomain",
			"blocked_ttl": "1h",
		},
	}
	b, _ := json.Marshal(payload)
	return b
}

func TestClient_Sync(t *testing.T) {
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sync/config" {
			t.Errorf("unexpected path %s", r.URL.Path)
			http.Error(w, "not found", 404)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", 405)
			return
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer token-123" {
			t.Errorf("missing or wrong Authorization header")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(minimalDNSAffectingConfig())
	}))
	defer primary.Close()

	dir := t.TempDir()
	defaultPath := filepath.Join(dir, "default.yaml")
	overridePath := filepath.Join(dir, "override.yaml")
	defaultConfig := `
server:
  listen: ["127.0.0.1:53"]
blocklists:
  refresh_interval: 6h
  sources: []
upstreams:
  - name: default
    address: https://dns.example.com/dns-query
    protocol: https
resolver_strategy: failover
response:
  blocked: nxdomain
  blocked_ttl: 1h
`
	if err := os.WriteFile(defaultPath, []byte(defaultConfig), 0600); err != nil {
		t.Fatalf("write default: %v", err)
	}

	blMgr := blocklist.NewManager(config.BlocklistConfig{}, logging.NewDiscardLogger())
	client := NewClient(ClientConfig{
		PrimaryURL:   primary.URL + "/",
		SyncToken:    "token-123",
		Interval:     config.Duration{Duration: 1 * time.Hour},
		ConfigPath:   overridePath,
		DefaultPath:  defaultPath,
		Blocklist:    blMgr,
		LocalRecords: nil,
		Resolver:     nil,
		Logger:       logging.NewDiscardLogger(),
	})

	err := client.sync(context.Background())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}

	data, err := os.ReadFile(overridePath)
	if err != nil {
		t.Fatalf("read override: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "blocklists") {
		t.Errorf("override should contain blocklists, got:\n%s", content)
	}
	if !strings.Contains(content, "blocked") {
		t.Errorf("override should contain response, got:\n%s", content)
	}
}

func TestClient_Sync_NonOK(t *testing.T) {
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal error", 500)
	}))
	defer primary.Close()

	dir := t.TempDir()
	defaultPath := filepath.Join(dir, "default.yaml")
	overridePath := filepath.Join(dir, "override.yaml")
	_ = os.WriteFile(defaultPath, []byte("server:\n  listen: [\"127.0.0.1:53\"]\n"), 0600)

	client := NewClient(ClientConfig{
		PrimaryURL:   primary.URL,
		SyncToken:    "token",
		ConfigPath:   overridePath,
		DefaultPath:  defaultPath,
		Logger:       logging.NewDiscardLogger(),
	})

	err := client.sync(context.Background())
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("error should mention 500, got %v", err)
	}
}

func TestClient_Sync_InvalidJSON(t *testing.T) {
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("not valid json"))
	}))
	defer primary.Close()

	dir := t.TempDir()
	defaultPath := filepath.Join(dir, "default.yaml")
	overridePath := filepath.Join(dir, "override.yaml")
	_ = os.WriteFile(defaultPath, []byte("server:\n  listen: [\"127.0.0.1:53\"]\n"), 0600)

	client := NewClient(ClientConfig{
		PrimaryURL:   primary.URL,
		SyncToken:    "token",
		ConfigPath:   overridePath,
		DefaultPath:  defaultPath,
		Logger:       logging.NewDiscardLogger(),
	})

	err := client.sync(context.Background())
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestClient_PushStats(t *testing.T) {
	var statsReceived bool
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sync/stats" {
			http.Error(w, "not found", 404)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		statsReceived = true
		w.WriteHeader(http.StatusOK)
	}))
	defer primary.Close()

	dir := t.TempDir()
	overridePath := filepath.Join(dir, "override.yaml")
	_ = os.WriteFile(overridePath, []byte("server:\n  listen: [\"127.0.0.1:53\"]\n"), 0600)

	blMgr := blocklist.NewManager(config.BlocklistConfig{}, logging.NewDiscardLogger())
	blMgr.LoadOnce(context.Background())

	cfg := config.Config{
		Server: config.ServerConfig{Listen: []string{"127.0.0.1:53"}},
		Upstreams: []config.UpstreamConfig{
			{Name: "doh", Address: "https://dns.example.com/dns-query", Protocol: "https"},
		},
		Blocklists: config.BlocklistConfig{RefreshInterval: config.Duration{Duration: time.Hour}, Sources: []config.BlocklistSource{}},
	}
	reqLog := requestlog.NewWriter(&bytes.Buffer{}, "text")
	resolver := dnsresolver.New(cfg, nil, localrecords.New(nil, nil), blMgr, logging.NewDiscardLogger(), reqLog, nil)

	client := NewClient(ClientConfig{
		PrimaryURL:   primary.URL,
		SyncToken:    "token",
		ConfigPath:   overridePath,
		DefaultPath:  filepath.Join(dir, "default.yaml"),
		Blocklist:    blMgr,
		Resolver:     resolver,
		Logger:       logging.NewDiscardLogger(),
	})

	client.pushStats(context.Background())

	if !statsReceived {
		t.Error("expected /sync/stats to be called")
	}
}

func TestClient_Run_ExitsOnContextCancel(t *testing.T) {
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/sync/config" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(minimalDNSAffectingConfig())
		} else if r.URL.Path == "/sync/stats" {
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer primary.Close()

	dir := t.TempDir()
	defaultPath := filepath.Join(dir, "default.yaml")
	overridePath := filepath.Join(dir, "override.yaml")
	defaultConfig := `
server:
  listen: ["127.0.0.1:53"]
blocklists:
  refresh_interval: 6h
  sources: []
upstreams:
  - name: default
    address: https://dns.example.com/dns-query
    protocol: https
resolver_strategy: failover
response:
  blocked: nxdomain
  blocked_ttl: 1h
`
	_ = os.WriteFile(defaultPath, []byte(defaultConfig), 0600)

	client := NewClient(ClientConfig{
		PrimaryURL:   primary.URL,
		SyncToken:    "token",
		Interval:     config.Duration{Duration: 24 * time.Hour},
		ConfigPath:   overridePath,
		DefaultPath:  defaultPath,
		Logger:       logging.NewDiscardLogger(),
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		client.Run(ctx)
		close(done)
	}()

	cancel()
	select {
	case <-done:
		// Run exited
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not exit after context cancel")
	}
}
