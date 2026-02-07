package blocklist

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
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
