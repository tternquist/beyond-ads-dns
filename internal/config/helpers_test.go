package config

import (
	"testing"
	"time"
)

func TestSyncConfigIsSyncTokenValid(t *testing.T) {
	c := &SyncConfig{
		Tokens: []SyncToken{
			{ID: "tok-abc", Name: "Replica A"},
			{ID: "tok-def", Name: ""},
		},
	}
	cases := []struct {
		token string
		want  bool
	}{
		{"tok-abc", true},
		{"tok-def", true},
		{"  tok-abc  ", true},
		{"missing", false},
		{"", false},
		{"   ", false},
	}
	for _, tc := range cases {
		if got := c.IsSyncTokenValid(tc.token); got != tc.want {
			t.Errorf("IsSyncTokenValid(%q) = %v, want %v", tc.token, got, tc.want)
		}
	}
}

func TestSyncConfigSyncTokenName(t *testing.T) {
	c := &SyncConfig{
		Tokens: []SyncToken{
			{ID: "tok-abc", Name: "Replica A"},
			{ID: "tok-def", Name: ""},
		},
	}
	if got := c.SyncTokenName("tok-abc"); got != "Replica A" {
		t.Errorf("SyncTokenName(known) = %q, want Replica A", got)
	}
	if got := c.SyncTokenName("  tok-abc  "); got != "Replica A" {
		t.Errorf("SyncTokenName(whitespace) = %q, want Replica A", got)
	}
	if got := c.SyncTokenName("tok-def"); got != "Replica" {
		t.Errorf("SyncTokenName(empty name) = %q, want Replica", got)
	}
	if got := c.SyncTokenName("missing"); got != "" {
		t.Errorf("SyncTokenName(missing) = %q, want \"\"", got)
	}
}

func TestWebhookOnBlockEffectiveTargets(t *testing.T) {
	// Nil receiver returns nil.
	var nilCfg *WebhookOnBlockConfig
	if got := nilCfg.EffectiveTargets(); got != nil {
		t.Errorf("nil EffectiveTargets() = %v, want nil", got)
	}

	// Targets explicitly set takes precedence.
	cfg := &WebhookOnBlockConfig{
		URL: "http://legacy.example.com",
		Targets: []WebhookTarget{
			{URL: "http://a.example.com"},
			{URL: "http://b.example.com"},
		},
	}
	got := cfg.EffectiveTargets()
	if len(got) != 2 || got[0].URL != "http://a.example.com" {
		t.Errorf("Targets precedence broken: %+v", got)
	}

	// Legacy URL with no targets synthesizes a target.
	legacy := &WebhookOnBlockConfig{
		URL:                  "http://legacy.example.com",
		Target:               "discord",
		Format:               "default",
		Context:              map[string]any{"env": "prod"},
		RateLimitPerMinute:   10,
		RateLimitMaxMessages: 20,
		RateLimitTimeframe:   "5m",
	}
	got = legacy.EffectiveTargets()
	if len(got) != 1 || got[0].URL != "http://legacy.example.com" {
		t.Fatalf("legacy fallback broken: %+v", got)
	}
	if got[0].Target != "discord" || got[0].Format != "default" {
		t.Errorf("legacy target fields lost: %+v", got[0])
	}
	if got[0].RateLimitMaxMessages != 20 || got[0].RateLimitTimeframe != "5m" {
		t.Errorf("legacy rate limit fields lost: %+v", got[0])
	}

	// Empty URL and no targets returns nil.
	empty := &WebhookOnBlockConfig{URL: "   "}
	if got := empty.EffectiveTargets(); got != nil {
		t.Errorf("empty config EffectiveTargets() = %v, want nil", got)
	}
}

func TestWebhookOnErrorEffectiveTargets(t *testing.T) {
	var nilCfg *WebhookOnErrorConfig
	if got := nilCfg.EffectiveTargets(); got != nil {
		t.Errorf("nil EffectiveTargets() = %v, want nil", got)
	}
	cfg := &WebhookOnErrorConfig{
		Targets: []WebhookTarget{{URL: "http://a.example.com"}},
	}
	if got := cfg.EffectiveTargets(); len(got) != 1 {
		t.Errorf("explicit targets length = %d, want 1", len(got))
	}
	legacy := &WebhookOnErrorConfig{
		URL:    "http://err.example.com",
		Target: "slack",
	}
	got := legacy.EffectiveTargets()
	if len(got) != 1 || got[0].URL != "http://err.example.com" || got[0].Target != "slack" {
		t.Errorf("legacy on_error fallback broken: %+v", got)
	}
	empty := &WebhookOnErrorConfig{}
	if got := empty.EffectiveTargets(); got != nil {
		t.Errorf("empty on_error EffectiveTargets() = %v, want nil", got)
	}
}

func TestWebhookTargetEffectiveRateLimit(t *testing.T) {
	tests := []struct {
		name             string
		target           WebhookTarget
		parentMax        int
		parentTimeframe  string
		wantMax          int
		wantTimeframe   time.Duration
	}{
		{
			name:           "explicit max + timeframe",
			target:         WebhookTarget{RateLimitMaxMessages: 30, RateLimitTimeframe: "10m"},
			wantMax:        30,
			wantTimeframe: 10 * time.Minute,
		},
		{
			name:          "legacy per-minute when max=0",
			target:        WebhookTarget{RateLimitPerMinute: 15},
			wantMax:       15,
			wantTimeframe: time.Minute,
		},
		{
			name:            "fallback to parent",
			target:          WebhookTarget{},
			parentMax:       100,
			parentTimeframe: "30s",
			wantMax:         100,
			wantTimeframe:   30 * time.Second,
		},
		{
			name:          "unlimited when target max = -1",
			target:        WebhookTarget{RateLimitMaxMessages: -1},
			wantMax:       -1,
			wantTimeframe: 0,
		},
		{
			name:            "unlimited via parent",
			target:          WebhookTarget{},
			parentMax:       -1,
			parentTimeframe: "1m",
			wantMax:         -1,
			wantTimeframe:   0,
		},
		{
			name:          "default timeframe when empty",
			target:        WebhookTarget{RateLimitMaxMessages: 5},
			wantMax:       5,
			wantTimeframe: time.Minute,
		},
		{
			name:          "invalid timeframe falls back to 1m",
			target:        WebhookTarget{RateLimitMaxMessages: 5, RateLimitTimeframe: "not-a-duration"},
			wantMax:       5,
			wantTimeframe: time.Minute,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotMax, gotTF := tt.target.EffectiveRateLimit(tt.parentMax, tt.parentTimeframe)
			if gotMax != tt.wantMax {
				t.Errorf("max = %d, want %d", gotMax, tt.wantMax)
			}
			if gotTF != tt.wantTimeframe {
				t.Errorf("timeframe = %v, want %v", gotTF, tt.wantTimeframe)
			}
		})
	}
}

func TestConfigDNSAffectingBasic(t *testing.T) {
	tru := true
	cfg := &Config{
		Upstreams: []UpstreamConfig{{Name: "primary", Address: "1.1.1.1:53", Protocol: "udp"}},
		Network: NetworkConfig{
			UpstreamTimeout: Duration{Duration: 7 * time.Second},
		},
		Blocklists: BlocklistConfig{
			RefreshInterval: Duration{Duration: 6 * time.Hour},
			Sources:         []BlocklistSource{{URL: "http://blocklist.example.com"}},
			Allowlist:       []string{"allow.example.com"},
			Denylist:        []string{"deny.example.com"},
		},
		ClientGroups: []ClientGroup{
			{
				ID:   "kids",
				Name: "Kids",
				Blocklist: &GroupBlocklistConfig{
					InheritGlobal: &tru,
					Allowlist:     []string{"safe.example.com"},
				},
				SafeSearch: &SafeSearchConfig{Enabled: &tru},
			},
			{
				ID:        "guests",
				Name:      "Guests",
				Blocklist: nil,
				// SafeSearch with no toggles set should be dropped.
				SafeSearch: &SafeSearchConfig{},
			},
		},
		Response: ResponseConfig{
			Blocked:    "nxdomain",
			BlockedTTL: Duration{Duration: time.Hour},
		},
	}

	out := cfg.DNSAffecting()

	if len(out.Upstreams) != 1 || out.Upstreams[0].Address != "1.1.1.1:53" {
		t.Errorf("Upstreams not propagated: %+v", out.Upstreams)
	}
	if out.UpstreamTimeout != "7s" {
		t.Errorf("UpstreamTimeout = %q, want 7s", out.UpstreamTimeout)
	}
	if out.Blocklists.RefreshInterval != "6h0m0s" {
		t.Errorf("RefreshInterval = %q, want 6h0m0s", out.Blocklists.RefreshInterval)
	}
	if out.Response.Blocked != "nxdomain" || out.Response.BlockedTTL != "1h0m0s" {
		t.Errorf("Response not propagated: %+v", out.Response)
	}
	if len(out.ClientGroups) != 2 {
		t.Fatalf("expected 2 client groups, got %d", len(out.ClientGroups))
	}
	kids := out.ClientGroups[0]
	if kids.Blocklist == nil || kids.SafeSearch == nil {
		t.Fatalf("kids group missing blocklist/safesearch: %+v", kids)
	}
	if len(kids.Blocklist.Allowlist) != 1 || kids.Blocklist.Allowlist[0] != "safe.example.com" {
		t.Errorf("kids allowlist wrong: %+v", kids.Blocklist.Allowlist)
	}
	guests := out.ClientGroups[1]
	if guests.SafeSearch != nil {
		t.Errorf("guests with empty safesearch should be nil, got %+v", guests.SafeSearch)
	}
}

func TestConfigDNSAffectingTimeoutFallbacks(t *testing.T) {
	// Legacy UpstreamTimeout (top-level) used when Network.UpstreamTimeout = 0.
	cfg := &Config{
		UpstreamTimeout: Duration{Duration: 3 * time.Second},
	}
	out := cfg.DNSAffecting()
	if out.UpstreamTimeout != "3s" {
		t.Errorf("legacy timeout fallback = %q, want 3s", out.UpstreamTimeout)
	}

	// When both are zero, default to "10s".
	cfg = &Config{}
	out = cfg.DNSAffecting()
	if out.UpstreamTimeout != "10s" {
		t.Errorf("zero timeout default = %q, want 10s", out.UpstreamTimeout)
	}
}
