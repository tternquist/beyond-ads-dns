package control

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/cache"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/dnsresolver"
	"github.com/tternquist/beyond-ads-dns/internal/localrecords"
	"github.com/tternquist/beyond-ads-dns/internal/logging"
	"github.com/tternquist/beyond-ads-dns/internal/requestlog"
)

type pingableCache struct {
	*cache.MockCache
	err error
}

func (c *pingableCache) PingRedis(_ context.Context) error {
	return c.err
}

func healthTestResolver(upstreams []config.UpstreamConfig) *dnsresolver.Resolver {
	return healthTestResolverWithCache(upstreams, nil)
}

func healthTestResolverWithCache(upstreams []config.UpstreamConfig, dnsCache cache.DNSCache) *dnsresolver.Resolver {
	blMgr := blocklist.NewManager(config.BlocklistConfig{}, logging.NewDiscardLogger())
	cfg := config.Config{Upstreams: upstreams}
	return dnsresolver.New(cfg, dnsCache, localrecords.New(nil, logging.NewDiscardLogger()), blMgr, logging.NewDiscardLogger(), requestlog.NewWriter(io.Discard, "text"), nil)
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

func TestHandleHealthReadyRedisStrictMode(t *testing.T) {
	upstreams := []config.UpstreamConfig{{Name: "cf", Address: "1.1.1.1:53"}}
	redisErr := errors.New("redis unavailable")
	tests := []struct {
		name      string
		path      string
		pingErr   error
		wantCode  int
		wantReady bool
		wantRedis string
	}{
		{
			name:      "redis ok is ready",
			path:      "/health/ready",
			wantCode:  http.StatusOK,
			wantReady: true,
			wantRedis: "ok",
		},
		{
			name:      "redis outage remains ready without strict",
			path:      "/health/ready",
			pingErr:   redisErr,
			wantCode:  http.StatusOK,
			wantReady: true,
			wantRedis: "unavailable",
		},
		{
			name:      "strict true marks redis outage unready",
			path:      "/health/ready?strict=true",
			pingErr:   redisErr,
			wantCode:  http.StatusServiceUnavailable,
			wantReady: false,
			wantRedis: "unavailable",
		},
		{
			name:      "strict one marks redis outage unready",
			path:      "/health/ready?strict=1",
			pingErr:   redisErr,
			wantCode:  http.StatusServiceUnavailable,
			wantReady: false,
			wantRedis: "unavailable",
		},
		{
			name:      "strict false is treated as non-strict",
			path:      "/health/ready?strict=false",
			pingErr:   redisErr,
			wantCode:  http.StatusOK,
			wantReady: true,
			wantRedis: "unavailable",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resolver := healthTestResolverWithCache(upstreams, &pingableCache{
				MockCache: cache.NewMockCache(),
				err:       tt.pingErr,
			})
			handler := handleHealthReady(resolver)

			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantCode {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, tt.wantCode, rec.Body.String())
			}
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("invalid JSON: %v", err)
			}
			if body["ready"] != tt.wantReady {
				t.Errorf("ready = %v, want %v", body["ready"], tt.wantReady)
			}
			if body["redis"] != tt.wantRedis {
				t.Errorf("redis = %v, want %s", body["redis"], tt.wantRedis)
			}
			if body["upstreams"] != float64(1) {
				t.Errorf("upstreams = %v, want 1", body["upstreams"])
			}
		})
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
