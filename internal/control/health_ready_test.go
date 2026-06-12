package control

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/dnsresolver"
	"github.com/tternquist/beyond-ads-dns/internal/localrecords"
	"github.com/tternquist/beyond-ads-dns/internal/logging"
	"github.com/tternquist/beyond-ads-dns/internal/requestlog"
)

func healthTestResolver(upstreams []config.UpstreamConfig) *dnsresolver.Resolver {
	blMgr := blocklist.NewManager(config.BlocklistConfig{}, logging.NewDiscardLogger())
	cfg := config.Config{Upstreams: upstreams}
	return dnsresolver.New(cfg, nil, localrecords.New(nil, logging.NewDiscardLogger()), blMgr, logging.NewDiscardLogger(), requestlog.NewWriter(io.Discard, "text"), nil)
}

func TestHandleHealthReady(t *testing.T) {
	resolver := healthTestResolver([]config.UpstreamConfig{{Name: "cf", Address: "1.1.1.1:53"}})
	handler := handleHealthReady(resolver)

	req := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body["ready"] != true {
		t.Errorf("ready = %v, want true", body["ready"])
	}
	// No Redis-backed cache configured.
	if body["redis"] != "disabled" {
		t.Errorf("redis = %v, want disabled", body["redis"])
	}
	if body["upstreams"] != float64(1) {
		t.Errorf("upstreams = %v, want 1", body["upstreams"])
	}
}

func TestHandleHealthReadyNoUpstreams(t *testing.T) {
	resolver := healthTestResolver(nil)
	handler := handleHealthReady(resolver)

	req := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503 when no upstreams configured", rec.Code)
	}
}

func TestHandleHealthReadyNilResolver(t *testing.T) {
	handler := handleHealthReady(nil)
	req := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 for nil resolver", rec.Code)
	}
}
