package control

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tternquist/beyond-ads-dns/internal/cache"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/dnsresolver"
	"github.com/tternquist/beyond-ads-dns/internal/localrecords"
	"github.com/tternquist/beyond-ads-dns/internal/logging"
	"github.com/tternquist/beyond-ads-dns/internal/metrics"
	"github.com/tternquist/beyond-ads-dns/internal/requestlog"
)

func newHandlerTestResolver() *dnsresolver.Resolver {
	reqLog := requestlog.NewWriter(&bytes.Buffer{}, "text")
	return dnsresolver.New(config.Config{}, cache.NewMockCache(),
		localrecords.New(nil, logging.NewDiscardLogger()), nil,
		logging.NewDiscardLogger(), reqLog, nil)
}

func TestHandleMetrics_ServesPrometheus(t *testing.T) {
	metrics.Init() // idempotent; required so Registry() is non-nil

	// nil resolver path: still serves the registry without panicking.
	handler := handleMetrics(nil)
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("nil resolver: status = %d, want 200", rec.Code)
	}

	// With a resolver, gauges get updated and the body contains Prometheus output.
	handler = handleMetrics(newHandlerTestResolver())
	req = httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("with resolver: status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/plain") {
		t.Errorf("Content-Type = %q, want prometheus text/plain", ct)
	}
}

func TestHandleCacheConfig(t *testing.T) {
	resolver := newHandlerTestResolver()

	t.Run("rejects GET with 405", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handleCacheConfig(resolver, "").ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/cache/config", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("status = %d, want 405", rec.Code)
		}
	})

	t.Run("rejects bad token with 401", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPut, "/cache/config", strings.NewReader(`{"max_keys":10}`))
		req.Header.Set("Authorization", "Bearer wrong")
		rec := httptest.NewRecorder()
		handleCacheConfig(resolver, "secret").ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401", rec.Code)
		}
	})

	t.Run("rejects invalid JSON with 400", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPut, "/cache/config", strings.NewReader(`not json`))
		rec := httptest.NewRecorder()
		handleCacheConfig(resolver, "").ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", rec.Code)
		}
	})

	t.Run("applies valid max_keys with 200", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPut, "/cache/config", strings.NewReader(`{"max_keys":500}`))
		rec := httptest.NewRecorder()
		handleCacheConfig(resolver, "").ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("status = %d, want 200", rec.Code)
		}
	})

	t.Run("clamps negative max_keys and returns 200", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPatch, "/cache/config", strings.NewReader(`{"max_keys":-5}`))
		rec := httptest.NewRecorder()
		handleCacheConfig(resolver, "").ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("status = %d, want 200", rec.Code)
		}
	})

	t.Run("nil resolver is a safe 200", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPut, "/cache/config", strings.NewReader(`{"max_keys":10}`))
		rec := httptest.NewRecorder()
		handleCacheConfig(nil, "").ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("status = %d, want 200", rec.Code)
		}
	})
}
