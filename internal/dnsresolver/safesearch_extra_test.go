package dnsresolver

import (
	"testing"

	"github.com/tternquist/beyond-ads-dns/internal/config"
)

func TestBuildSafeSearchMapYouTubeAndDuckDuckGo(t *testing.T) {
	m := buildSafeSearchMapFromConfig(config.SafeSearchConfig{
		Enabled:    ptr(true),
		Google:     ptr(false),
		Bing:       ptr(false),
		DuckDuckGo: ptr(true),
		YouTube:    "strict",
	})
	if m == nil {
		t.Fatal("expected non-nil safe search map")
	}
	if got := m["www.youtube.com"]; got != "restrict.youtube.com" {
		t.Errorf("www.youtube.com -> %q, want restrict.youtube.com", got)
	}
	if got := m["m.youtube.com"]; got != "restrict.youtube.com" {
		t.Errorf("m.youtube.com -> %q, want restrict.youtube.com", got)
	}
	if got := m["duckduckgo.com"]; got != "safe.duckduckgo.com" {
		t.Errorf("duckduckgo.com -> %q, want safe.duckduckgo.com", got)
	}
	if _, ok := m["www.google.com"]; ok {
		t.Error("google disabled: www.google.com should not be in map")
	}
}

func TestBuildSafeSearchMapYouTubeModerate(t *testing.T) {
	m := buildSafeSearchMapFromConfig(config.SafeSearchConfig{
		Enabled: ptr(true),
		Google:  ptr(false),
		Bing:    ptr(false),
		YouTube: "moderate",
	})
	if got := m["www.youtube.com"]; got != "restrictmoderate.youtube.com" {
		t.Errorf("www.youtube.com -> %q, want restrictmoderate.youtube.com", got)
	}
}

func TestBuildSafeSearchMapBackwardCompatible(t *testing.T) {
	// Existing configs (google/bing only) must be unaffected: youtube off,
	// duckduckgo off by default.
	m := buildSafeSearchMapFromConfig(config.SafeSearchConfig{Enabled: ptr(true)})
	if got := m["www.google.com"]; got != "forcesafesearch.google.com" {
		t.Errorf("www.google.com -> %q, want forcesafesearch.google.com", got)
	}
	if _, ok := m["www.youtube.com"]; ok {
		t.Error("youtube should be off by default")
	}
	if _, ok := m["duckduckgo.com"]; ok {
		t.Error("duckduckgo should be off by default")
	}
}
