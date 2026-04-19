package control

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/time/rate"
)

// --- authorize ---

func TestAuthorize_EmptyToken_AlwaysAllows(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if !authorize("", req) {
		t.Error("expected authorize to return true when token is empty")
	}
}

func TestAuthorize_CorrectBearerToken(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	if !authorize("secret-token", req) {
		t.Error("expected authorize to return true with correct bearer token")
	}
}

func TestAuthorize_BearerToken_CaseInsensitivePrefix(t *testing.T) {
	for _, prefix := range []string{"Bearer", "BEARER", "bearer", "BeArEr"} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", prefix+" my-token")
		if !authorize("my-token", req) {
			t.Errorf("expected authorize to accept %q prefix", prefix)
		}
	}
}

func TestAuthorize_WrongBearerToken(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")
	if authorize("secret-token", req) {
		t.Error("expected authorize to return false with wrong bearer token")
	}
}

func TestAuthorize_CorrectXAuthToken(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Auth-Token", "secret-token")
	if !authorize("secret-token", req) {
		t.Error("expected authorize to return true with correct X-Auth-Token header")
	}
}

func TestAuthorize_WrongXAuthToken(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Auth-Token", "wrong")
	if authorize("secret-token", req) {
		t.Error("expected authorize to return false with wrong X-Auth-Token header")
	}
}

func TestAuthorize_NoCredentials_Fails(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if authorize("secret-token", req) {
		t.Error("expected authorize to return false when no credentials provided")
	}
}

func TestAuthorize_BearerTokenWithWhitespace(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer   my-token  ")
	if !authorize("my-token", req) {
		t.Error("expected authorize to trim whitespace around bearer token")
	}
}

// --- extractSyncToken ---

func TestExtractSyncToken_Bearer(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer sync-abc-123")
	got := extractSyncToken(req)
	if got != "sync-abc-123" {
		t.Errorf("expected sync-abc-123, got %q", got)
	}
}

func TestExtractSyncToken_XSyncToken(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Sync-Token", "my-sync-token")
	got := extractSyncToken(req)
	if got != "my-sync-token" {
		t.Errorf("expected my-sync-token, got %q", got)
	}
}

func TestExtractSyncToken_Empty(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	got := extractSyncToken(req)
	if got != "" {
		t.Errorf("expected empty string, got %q", got)
	}
}

// --- rateLimitHandler ---

func TestRateLimitHandler_AllowsRequestsWithinBurst(t *testing.T) {
	called := 0
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called++
		w.WriteHeader(http.StatusOK)
	})
	// burst of 3, very slow refill so none refill during the test
	handler := rateLimitHandler(inner, rate.Every(time.Hour), 3)

	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodPost, "/", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("request %d: expected 200, got %d", i+1, rec.Code)
		}
	}
	if called != 3 {
		t.Errorf("expected inner handler called 3 times, got %d", called)
	}
}

func TestRateLimitHandler_RejectsWhenBurstExceeded(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := rateLimitHandler(inner, rate.Every(time.Hour), 2)

	// Consume the burst
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/", nil))
	}

	// Next request should be rate-limited
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/", nil))
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429 on rate-limited request, got %d", rec.Code)
	}

	// Rate-limited response should include error JSON
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode rate-limit response: %v", err)
	}
	if _, ok := body["error"]; !ok {
		t.Errorf("expected error key in rate-limit response, got %v", body)
	}
}

func TestRateLimitHandler_EachHandlerHasItsOwnLimiter(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	// Two separate wrapped handlers — each should have its own independent limiter
	h1 := rateLimitHandler(inner, rate.Every(time.Hour), 1)
	h2 := rateLimitHandler(inner, rate.Every(time.Hour), 1)

	// Exhaust h1
	h1.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/", nil))
	rec1 := httptest.NewRecorder()
	h1.ServeHTTP(rec1, httptest.NewRequest(http.MethodPost, "/", nil))
	if rec1.Code != http.StatusTooManyRequests {
		t.Errorf("h1: expected 429 after burst, got %d", rec1.Code)
	}

	// h2 should still be within its own burst
	rec2 := httptest.NewRecorder()
	h2.ServeHTTP(rec2, httptest.NewRequest(http.MethodPost, "/", nil))
	if rec2.Code != http.StatusOK {
		t.Errorf("h2: expected 200 (independent limiter), got %d", rec2.Code)
	}
}

// --- handleHealth ---

func TestHandleHealth_ReturnsOK(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handleHealth(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode health response: %v", err)
	}
	if body["ok"] != true {
		t.Errorf("expected ok: true, got %v", body)
	}
}

func TestHandleHealth_ContentTypeJSON(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handleHealth(rec, req)

	ct := rec.Header().Get("Content-Type")
	if !strings.Contains(ct, "application/json") {
		t.Errorf("expected Content-Type application/json, got %q", ct)
	}
}
