package blocklist

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/logging"
)

func BenchmarkManagerIsBlocked(b *testing.B) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ads.example.com\nblocked.test\n")
	}))
	defer server.Close()

	cfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources: []config.BlocklistSource{
			{Name: "test", URL: server.URL},
		},
		Allowlist: []string{},
		Denylist:  []string{},
	}
	manager := NewManager(cfg, logging.NewDiscardLogger())
	if err := manager.LoadOnce(context.Background()); err != nil {
		b.Fatalf("LoadOnce: %v", err)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = manager.IsBlocked("ads.example.com")
	}
}

func BenchmarkManagerIsBlockedNegative(b *testing.B) {
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
		Denylist:  []string{},
	}
	manager := NewManager(cfg, logging.NewDiscardLogger())
	if err := manager.LoadOnce(context.Background()); err != nil {
		b.Fatalf("LoadOnce: %v", err)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = manager.IsBlocked("not-in-list.example.com")
	}
}
