package control

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/cache"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/dnsresolver"
	"github.com/tternquist/beyond-ads-dns/internal/localrecords"
	"github.com/tternquist/beyond-ads-dns/internal/logging"
	"github.com/tternquist/beyond-ads-dns/internal/requestlog"
)

func healthTestResolver(upstreams []config.UpstreamConfig) *dnsresolver.Resolver {
	return healthTestResolverWithCache(upstreams, nil)
}

func healthTestResolverWithCache(upstreams []config.UpstreamConfig, cacheClient cache.DNSCache) *dnsresolver.Resolver {
	blMgr := blocklist.NewManager(config.BlocklistConfig{}, logging.NewDiscardLogger())
	cfg := config.Config{Upstreams: upstreams}
	return dnsresolver.New(cfg, cacheClient, localrecords.New(nil, logging.NewDiscardLogger()), blMgr, logging.NewDiscardLogger(), requestlog.NewWriter(io.Discard, "text"), nil)
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

func TestHandleHealthReadyRedisDependency(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	redisCache, err := cache.NewRedisCache(config.RedisConfig{Mode: "standalone", Address: mr.Addr()}, nil)
	if err != nil {
		mr.Close()
		t.Fatalf("NewRedisCache: %v", err)
	}
	t.Cleanup(func() {
		_ = redisCache.Close()
		if mr != nil {
			mr.Close()
		}
	})

	resolver := healthTestResolverWithCache([]config.UpstreamConfig{{Name: "cf", Address: "1.1.1.1:53"}}, redisCache)
	handler := handleHealthReady(resolver)

	t.Run("redis ok", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		body := decodeHealthReadyBody(t, rec)
		if body["ready"] != true {
			t.Errorf("ready = %v, want true", body["ready"])
		}
		if body["redis"] != "ok" {
			t.Errorf("redis = %v, want ok", body["redis"])
		}
	})

	mr.Close()
	mr = nil

	t.Run("non-strict stays ready when redis unavailable", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		body := decodeHealthReadyBody(t, rec)
		if body["ready"] != true {
			t.Errorf("ready = %v, want true", body["ready"])
		}
		if body["redis"] != "unavailable" {
			t.Errorf("redis = %v, want unavailable", body["redis"])
		}
	})

	t.Run("strict fails when redis unavailable", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/health/ready?strict=true", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503", rec.Code)
		}
		body := decodeHealthReadyBody(t, rec)
		if body["ready"] != false {
			t.Errorf("ready = %v, want false", body["ready"])
		}
		if body["redis"] != "unavailable" {
			t.Errorf("redis = %v, want unavailable", body["redis"])
		}
	})
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

func decodeHealthReadyBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	return body
}
