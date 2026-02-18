package control

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/cache"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/dnsresolver"
	"github.com/tternquist/beyond-ads-dns/internal/errorlog"
	"github.com/tternquist/beyond-ads-dns/internal/localrecords"
	"github.com/tternquist/beyond-ads-dns/internal/logging"
	"github.com/tternquist/beyond-ads-dns/internal/requestlog"
	"github.com/tternquist/beyond-ads-dns/internal/tracelog"
)

func writeTempConfig(t *testing.T, data []byte) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("failed to write temp config: %v", err)
	}
	return path
}

func TestLoadConfigForReload_InvalidPath(t *testing.T) {
	// loadConfigForReload is unexported; test via handleBlocklistsReload.
	// When config path causes Load to fail, handler returns 500 with error JSON.
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
blocklists:
  sources: []
`))
	// Use non-existent default to make config.Load fail
	os.Setenv("DEFAULT_CONFIG_PATH", "/nonexistent/config/default.yaml")
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{},
		Sources:         []config.BlocklistSource{},
	}
	manager := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	handler := handleBlocklistsReload(manager, nil, defaultPath, "")

	req := httptest.NewRequest(http.MethodPost, "/blocklists/reload", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if _, ok := body["error"]; !ok {
		t.Errorf("expected error key in response, got %v", body)
	}
}

func TestLoadConfigForReload_ValidPath(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
blocklists:
  sources: []
  allowlist: []
  denylist: []
`))
	overridePath := writeTempConfig(t, []byte(`
blocklists:
  sources: []
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{},
		Sources:         []config.BlocklistSource{},
	}
	manager := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	handler := handleBlocklistsReload(manager, nil, overridePath, "")

	req := httptest.NewRequest(http.MethodPost, "/blocklists/reload", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if v, ok := body["ok"]; !ok || v != true {
		t.Errorf("expected ok: true, got %v", body)
	}
}

func TestHandleBlocklistsReload_MethodNotAllowed(t *testing.T) {
	blCfg := config.BlocklistConfig{Sources: []config.BlocklistSource{}}
	manager := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	handler := handleBlocklistsReload(manager, nil, "/nonexistent", "")

	req := httptest.NewRequest(http.MethodGet, "/blocklists/reload", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", rec.Code)
	}
}

func TestHandleBlocklistsReload_UnauthorizedWhenTokenRequired(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
blocklists:
  sources: []
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	blCfg := config.BlocklistConfig{Sources: []config.BlocklistSource{}}
	manager := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	handler := handleBlocklistsReload(manager, nil, defaultPath, "secret-token")

	req := httptest.NewRequest(http.MethodPost, "/blocklists/reload", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestHandleBlocklistsReload_AuthorizedWithBearerToken(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
blocklists:
  sources: []
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	blCfg := config.BlocklistConfig{Sources: []config.BlocklistSource{}}
	manager := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	handler := handleBlocklistsReload(manager, nil, defaultPath, "secret-token")

	req := httptest.NewRequest(http.MethodPost, "/blocklists/reload", nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandleLocalRecordsReload_InvalidPath(t *testing.T) {
	os.Setenv("DEFAULT_CONFIG_PATH", "/nonexistent/default.yaml")
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	localMgr := localrecords.New(nil, logging.NewDiscardLogger())
	handler := handleLocalRecordsReload(localMgr, "/nonexistent/override.yaml", "")

	req := httptest.NewRequest(http.MethodPost, "/local-records/reload", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if _, ok := body["error"]; !ok {
		t.Errorf("expected error key, got %v", body)
	}
}

func TestHandleUpstreamsReload_NilResolver(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
upstreams:
  - name: test
    address: "1.1.1.1:53"
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	handler := handleUpstreamsReload(nil, defaultPath, "")

	req := httptest.NewRequest(http.MethodPost, "/upstreams/reload", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 (nil resolver is no-op), got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if v, ok := body["ok"]; !ok || v != true {
		t.Errorf("expected ok: true, got %v", body)
	}
}

func TestHandleHealth(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handleHealth(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if v, ok := body["ok"]; !ok || v != true {
		t.Errorf("expected ok: true, got %v", body)
	}
}

func TestAuthorize(t *testing.T) {
	tests := []struct {
		name   string
		token  string
		auth   string
		xToken string
		want   bool
	}{
		{"no token required", "", "", "", true},
		{"bearer match", "secret", "Bearer secret", "", true},
		{"bearer mismatch", "secret", "Bearer wrong", "", false},
		{"x-auth-token match", "secret", "", "secret", true},
		{"x-auth-token mismatch", "secret", "", "wrong", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if tt.auth != "" {
				req.Header.Set("Authorization", tt.auth)
			}
			if tt.xToken != "" {
				req.Header.Set("X-Auth-Token", tt.xToken)
			}
			got := authorize(tt.token, req)
			if got != tt.want {
				t.Errorf("authorize() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestHandleErrors(t *testing.T) {
	buf := errorlog.NewBuffer(io.Discard, 10, "warning", nil, nil)
	handler := handleErrors(buf, "")

	req := httptest.NewRequest(http.MethodGet, "/errors", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if _, ok := body["errors"]; !ok {
		t.Errorf("expected errors key, got %v", body)
	}
}

func TestHandleErrors_UnauthorizedWhenTokenRequired(t *testing.T) {
	buf := errorlog.NewBuffer(io.Discard, 10, "warning", nil, nil)
	handler := handleErrors(buf, "secret-token")

	req := httptest.NewRequest(http.MethodGet, "/errors", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestHandleErrors_MethodNotAllowed(t *testing.T) {
	buf := errorlog.NewBuffer(io.Discard, 10, "warning", nil, nil)
	handler := handleErrors(buf, "")

	req := httptest.NewRequest(http.MethodPost, "/errors", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", rec.Code)
	}
}

func TestHandleTraceEvents(t *testing.T) {
	events := tracelog.New([]string{"refresh_upstream"})
	handler := handleTraceEvents(events, "")

	// GET returns enabled events and all_events
	req := httptest.NewRequest(http.MethodGet, "/trace-events", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("GET expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var getBody map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&getBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	evs, ok := getBody["events"].([]any)
	if !ok || len(evs) != 1 || evs[0] != "refresh_upstream" {
		t.Errorf("GET events = %v, want [refresh_upstream]", getBody["events"])
	}
	if _, ok := getBody["all_events"]; !ok {
		t.Errorf("GET expected all_events key")
	}

	// PUT updates events
	req = httptest.NewRequest(http.MethodPut, "/trace-events", bytes.NewReader([]byte(`{"events":[]}`)))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("PUT expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := events.Get(); len(got) != 0 {
		t.Errorf("after PUT events=[]: got %v, want []", got)
	}

	// PUT with invalid event name is ignored
	req = httptest.NewRequest(http.MethodPut, "/trace-events", bytes.NewReader([]byte(`{"events":["refresh_upstream","invalid_event"]}`)))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("PUT expected 200, got %d", rec.Code)
	}
	if got := events.Get(); len(got) != 1 || got[0] != "refresh_upstream" {
		t.Errorf("invalid event should be ignored: got %v", got)
	}
}

func TestHandleTraceEvents_NilEvents(t *testing.T) {
	handler := handleTraceEvents(nil, "")
	req := httptest.NewRequest(http.MethodGet, "/trace-events", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if evs, ok := body["events"].([]any); !ok || len(evs) != 0 {
		t.Errorf("nil events should return empty: got %v", body["events"])
	}
}

func TestHandleBlockedCheck(t *testing.T) {
	blCfg := config.BlocklistConfig{
		Sources:  []config.BlocklistSource{},
		Denylist: []string{"blocked.example.com"},
	}
	manager := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	if err := manager.LoadOnce(nil); err != nil {
		t.Fatalf("LoadOnce: %v", err)
	}
	handler := handleBlockedCheck(manager)

	tests := []struct {
		domain string
		want  bool
	}{
		{"blocked.example.com", true},
		{"allowed.example.com", false},
		{"", false}, // missing domain
	}
	for _, tt := range tests {
		t.Run(tt.domain, func(t *testing.T) {
			url := "/blocked/check"
			if tt.domain != "" {
				url = "/blocked/check?domain=" + tt.domain
			}
			req := httptest.NewRequest(http.MethodGet, url, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if tt.domain == "" {
				if rec.Code != http.StatusBadRequest {
					t.Errorf("missing domain: expected 400, got %d", rec.Code)
				}
				return
			}
			if rec.Code != http.StatusOK {
				t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
			}
			var body map[string]any
			if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if got, ok := body["blocked"].(bool); !ok || got != tt.want {
				t.Errorf("blocked = %v, want %v", body["blocked"], tt.want)
			}
		})
	}
}

func TestExtractSyncToken(t *testing.T) {
	tests := []struct {
		name   string
		auth   string
		xToken string
		want   string
	}{
		{"bearer", "Bearer tok123", "", "tok123"},
		{"x-sync-token", "", "tok456", "tok456"},
		{"empty", "", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if tt.auth != "" {
				req.Header.Set("Authorization", tt.auth)
			}
			if tt.xToken != "" {
				req.Header.Set("X-Sync-Token", tt.xToken)
			}
			got := extractSyncToken(req)
			if got != tt.want {
				t.Errorf("extractSyncToken() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestWriteJSON(t *testing.T) {
	rec := httptest.NewRecorder()
	writeJSON(rec, http.StatusCreated, map[string]any{"id": 42, "name": "test"})

	if rec.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["id"] != float64(42) || body["name"] != "test" {
		t.Errorf("body = %v", body)
	}
}

func TestHandleResponseReload_InvalidPath(t *testing.T) {
	os.Setenv("DEFAULT_CONFIG_PATH", "/nonexistent/default.yaml")
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	handler := handleResponseReload(nil, "/nonexistent/override.yaml", "")
	req := httptest.NewRequest(http.MethodPost, "/response/reload", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rec.Code)
	}
}

func TestHandleSafeSearchReload_InvalidPath(t *testing.T) {
	os.Setenv("DEFAULT_CONFIG_PATH", "/nonexistent/default.yaml")
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	handler := handleSafeSearchReload(nil, "/nonexistent/override.yaml", "")
	req := httptest.NewRequest(http.MethodPost, "/safe-search/reload", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rec.Code)
	}
}

func TestHandleClientIdentificationReload_InvalidPath(t *testing.T) {
	os.Setenv("DEFAULT_CONFIG_PATH", "/nonexistent/default.yaml")
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	handler := handleClientIdentificationReload(nil, "/nonexistent/override.yaml", "")
	req := httptest.NewRequest(http.MethodPost, "/client-identification/reload", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rec.Code)
	}
}

func TestHandleClientIdentificationReload_ValidPath_ListFormat(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
upstreams:
  - name: test
    address: "1.1.1.1:53"
`))
	overridePath := writeTempConfig(t, []byte(`
client_identification:
  enabled: true
  clients:
    - ip: "192.168.1.10"
      name: "Kids Tablet"
      group_id: "kids"
    - ip: "192.168.1.11"
      name: "Adults Phone"
      group_id: "adults"
client_groups:
  - id: "kids"
    name: "Kids"
  - id: "adults"
    name: "Adults"
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	blCfg := config.BlocklistConfig{Sources: []config.BlocklistSource{}}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	cfg, err := config.LoadWithFiles(defaultPath, overridePath)
	if err != nil {
		t.Fatalf("LoadWithFiles: %v", err)
	}
	resolver := dnsresolver.New(cfg, nil, localrecords.New(nil, logging.NewDiscardLogger()), blMgr, logging.NewDiscardLogger(), requestlog.NewWriter(io.Discard, "text"), nil)
	handler := handleClientIdentificationReload(resolver, overridePath, "")

	req := httptest.NewRequest(http.MethodPost, "/client-identification/reload", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if v, ok := body["ok"].(bool); !ok || !v {
		t.Errorf("expected ok: true, got %v", body)
	}
}

func TestHandleLocalRecordsReload_ValidPath(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
local_records: []
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	localMgr := localrecords.New(nil, logging.NewDiscardLogger())
	handler := handleLocalRecordsReload(localMgr, defaultPath, "")

	req := httptest.NewRequest(http.MethodPost, "/local-records/reload", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandleBlocklistsStats(t *testing.T) {
	blCfg := config.BlocklistConfig{Sources: []config.BlocklistSource{}}
	manager := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	handler := handleBlocklistsStats(manager, "")

	req := httptest.NewRequest(http.MethodGet, "/blocklists/stats", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, ok := body["blocked"]; !ok {
		t.Errorf("expected blocked key, got %v", body)
	}
}

func TestHandleBlocklistsPauseStatus(t *testing.T) {
	blCfg := config.BlocklistConfig{Sources: []config.BlocklistSource{}}
	manager := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	handler := handleBlocklistsPauseStatus(manager, "")

	req := httptest.NewRequest(http.MethodGet, "/blocklists/pause/status", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, ok := body["paused"]; !ok {
		t.Errorf("expected paused key, got %v", body)
	}
}

func TestHandleBlocklistsResume(t *testing.T) {
	blCfg := config.BlocklistConfig{Sources: []config.BlocklistSource{}}
	manager := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	handler := handleBlocklistsResume(manager, "")

	req := httptest.NewRequest(http.MethodPost, "/blocklists/resume", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if v, ok := body["paused"].(bool); !ok || v != false {
		t.Errorf("expected paused: false, got %v", body)
	}
}

func TestHandleBlocklistsPause(t *testing.T) {
	blCfg := config.BlocklistConfig{Sources: []config.BlocklistSource{}}
	manager := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	handler := handleBlocklistsPause(manager, "")

	req := httptest.NewRequest(http.MethodPost, "/blocklists/pause", strings.NewReader(`{"duration_minutes": 5}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if v, ok := body["paused"].(bool); !ok || !v {
		t.Errorf("expected paused: true after pause, got %v", body)
	}
}

func TestHandleBlocklistsPause_InvalidDuration(t *testing.T) {
	blCfg := config.BlocklistConfig{Sources: []config.BlocklistSource{}}
	manager := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	handler := handleBlocklistsPause(manager, "")

	tests := []struct {
		body string
		want int
	}{
		{`{"duration_minutes": 0}`, http.StatusBadRequest},
		{`{"duration_minutes": 2000}`, http.StatusBadRequest},
		{`{}`, http.StatusBadRequest},
		{`invalid`, http.StatusBadRequest},
	}
	for _, tt := range tests {
		req := httptest.NewRequest(http.MethodPost, "/blocklists/pause", strings.NewReader(tt.body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != tt.want {
			t.Errorf("body %q: got %d, want %d", tt.body, rec.Code, tt.want)
		}
	}
}

func TestHandleBlocklistsHealth(t *testing.T) {
	blCfg := config.BlocklistConfig{Sources: []config.BlocklistSource{}}
	manager := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	handler := handleBlocklistsHealth(manager, "")

	req := httptest.NewRequest(http.MethodGet, "/blocklists/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, ok := body["sources"]; !ok {
		t.Errorf("expected sources key, got %v", body)
	}
}

func TestHandleUpstreams_NilResolver(t *testing.T) {
	handler := handleUpstreams(nil, "")

	req := httptest.NewRequest(http.MethodGet, "/upstreams", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	upstreams, ok := body["upstreams"].([]any)
	if !ok || len(upstreams) != 0 {
		t.Errorf("expected empty upstreams for nil resolver, got %v", body)
	}
}

func TestHandleCacheStats_NilResolver(t *testing.T) {
	handler := handleCacheStats(nil, "")

	req := httptest.NewRequest(http.MethodGet, "/cache/stats", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestHandleCacheRefreshStats_NilResolver(t *testing.T) {
	handler := handleCacheRefreshStats(nil, "")

	req := httptest.NewRequest(http.MethodGet, "/cache/refresh/stats", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestHandleQuerystoreStats_NilResolver(t *testing.T) {
	handler := handleQuerystoreStats(nil, "")

	req := httptest.NewRequest(http.MethodGet, "/querystore/stats", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestHandleCacheClear_NilResolver(t *testing.T) {
	handler := handleCacheClear(nil, "")

	req := httptest.NewRequest(http.MethodPost, "/cache/clear", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 for nil resolver (no-op), got %d", rec.Code)
	}
}

func TestHandleBlocklistsReload_AuthorizedWithXAuthToken(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`
server:
  listen: ["127.0.0.1:53"]
blocklists:
  sources: []
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	blCfg := config.BlocklistConfig{Sources: []config.BlocklistSource{}}
	manager := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	handler := handleBlocklistsReload(manager, nil, defaultPath, "secret-token")

	req := httptest.NewRequest(http.MethodPost, "/blocklists/reload", nil)
	req.Header.Set("X-Auth-Token", "secret-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandleCacheStats_WithResolver(t *testing.T) {
	blCfg := config.BlocklistConfig{Sources: []config.BlocklistSource{}}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	cfg := config.Config{
		Server:           config.ServerConfig{Listen: []string{"127.0.0.1:53"}},
		Upstreams:        []config.UpstreamConfig{{Name: "test", Address: "1.1.1.1:53"}},
		ResolverStrategy: "failover",
		Blocklists:       blCfg,
		Cache: config.CacheConfig{
			MinTTL:      config.Duration{Duration: 5 * time.Minute},
			MaxTTL:      config.Duration{Duration: time.Hour},
			NegativeTTL: config.Duration{Duration: 5 * time.Minute},
		},
		Response: config.ResponseConfig{
			Blocked:    "nxdomain",
			BlockedTTL: config.Duration{Duration: time.Hour},
		},
		QueryStore: config.QueryStoreConfig{Enabled: ptr(false)},
	}
	mockCache := cache.NewMockCache()
	reqLog := requestlog.NewWriter(&bytes.Buffer{}, "text")
	resolver := dnsresolver.New(cfg, mockCache, localrecords.New(nil, logging.NewDiscardLogger()), blMgr, logging.NewDiscardLogger(), reqLog, nil)

	handler := handleCacheStats(resolver, "")
	req := httptest.NewRequest(http.MethodGet, "/cache/stats", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, ok := body["hit_rate"]; !ok {
		t.Errorf("expected hit_rate in cache stats, got %v", body)
	}
}

func TestHandleCacheRefreshStats_WithResolver(t *testing.T) {
	blCfg := config.BlocklistConfig{Sources: []config.BlocklistSource{}}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	cfg := config.Config{
		Server:           config.ServerConfig{Listen: []string{"127.0.0.1:53"}},
		Upstreams:        []config.UpstreamConfig{{Name: "test", Address: "1.1.1.1:53"}},
		ResolverStrategy: "failover",
		Blocklists:       blCfg,
		Cache: config.CacheConfig{
			MinTTL:      config.Duration{Duration: 5 * time.Minute},
			MaxTTL:      config.Duration{Duration: time.Hour},
			NegativeTTL: config.Duration{Duration: 5 * time.Minute},
		},
		Response: config.ResponseConfig{
			Blocked:    "nxdomain",
			BlockedTTL: config.Duration{Duration: time.Hour},
		},
		QueryStore: config.QueryStoreConfig{Enabled: ptr(false)},
	}
	mockCache := cache.NewMockCache()
	reqLog := requestlog.NewWriter(&bytes.Buffer{}, "text")
	resolver := dnsresolver.New(cfg, mockCache, localrecords.New(nil, logging.NewDiscardLogger()), blMgr, logging.NewDiscardLogger(), reqLog, nil)

	handler := handleCacheRefreshStats(resolver, "")
	req := httptest.NewRequest(http.MethodGet, "/cache/refresh/stats", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, ok := body["last_sweep_count"]; !ok {
		t.Errorf("expected last_sweep_count in refresh stats, got %v", body)
	}
}

func TestHandleUpstreams_WithResolver(t *testing.T) {
	blCfg := config.BlocklistConfig{Sources: []config.BlocklistSource{}}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	cfg := config.Config{
		Server:           config.ServerConfig{Listen: []string{"127.0.0.1:53"}},
		Upstreams:        []config.UpstreamConfig{{Name: "cloudflare", Address: "1.1.1.1:53"}, {Name: "google", Address: "8.8.8.8:53"}},
		ResolverStrategy: "failover",
		Blocklists:       blCfg,
		Cache: config.CacheConfig{
			MinTTL:      config.Duration{Duration: 5 * time.Minute},
			MaxTTL:      config.Duration{Duration: time.Hour},
			NegativeTTL: config.Duration{Duration: 5 * time.Minute},
		},
		Response: config.ResponseConfig{
			Blocked:    "nxdomain",
			BlockedTTL: config.Duration{Duration: time.Hour},
		},
		QueryStore: config.QueryStoreConfig{Enabled: ptr(false)},
	}
	mockCache := cache.NewMockCache()
	reqLog := requestlog.NewWriter(&bytes.Buffer{}, "text")
	resolver := dnsresolver.New(cfg, mockCache, localrecords.New(nil, logging.NewDiscardLogger()), blMgr, logging.NewDiscardLogger(), reqLog, nil)

	handler := handleUpstreams(resolver, "")
	req := httptest.NewRequest(http.MethodGet, "/upstreams", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	upstreams, ok := body["upstreams"].([]any)
	if !ok || len(upstreams) != 2 {
		t.Errorf("expected 2 upstreams, got %v", body)
	}
}

func ptr(b bool) *bool {
	return &b
}
