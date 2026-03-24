package dnsresolver

import (
	"testing"
)

// --- dotAddress ---

func TestDotAddress_StripsPrefix(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"tls://8.8.8.8:853", "8.8.8.8:853"},
		{"tls://dns.example.com:853", "dns.example.com:853"},
		{"8.8.8.8:853", "8.8.8.8:853"}, // no prefix — unchanged
	}
	for _, c := range cases {
		got := dotAddress(c.input)
		if got != c.want {
			t.Errorf("dotAddress(%q) = %q, want %q", c.input, got, c.want)
		}
	}
}

// --- quicAddress ---

func TestQuicAddress_StripsPrefix(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"quic://dns.example.com:853", "dns.example.com:853"},
		{"quic://1.1.1.1:853", "1.1.1.1:853"},
		{"1.1.1.1:853", "1.1.1.1:853"}, // no prefix — unchanged
	}
	for _, c := range cases {
		got := quicAddress(c.input)
		if got != c.want {
			t.Errorf("quicAddress(%q) = %q, want %q", c.input, got, c.want)
		}
	}
}

// --- exchangeWithUpstream (unsupported protocol) ---

func TestExchangeWithUpstream_UnsupportedProtocol(t *testing.T) {
	// Build the minimal resolver needed to call exchangeWithUpstream.
	// A nil upstreamMgr causes a panic; provide a real one.
	mgr := newUpstreamManager(nil, StrategyFailover, 0, 0, 0, false)
	r := &Resolver{upstreamMgr: mgr}

	upstream := Upstream{
		Name:     "bad",
		Address:  "8.8.8.8:53",
		Protocol: "grpc", // unsupported
	}
	_, _, err := r.exchangeWithUpstream(nil, upstream)
	if err == nil {
		t.Fatal("expected error for unsupported protocol, got nil")
	}
}

// --- tlsClientFor ---

func TestTlsClientFor_LazyInitialization(t *testing.T) {
	mgr := newUpstreamManager(nil, StrategyFailover, 0, 0, 0, false)
	r := &Resolver{upstreamMgr: mgr}

	addr := "tls://8.8.8.8:853"
	c1 := r.tlsClientFor(addr)
	if c1 == nil {
		t.Fatal("expected non-nil TLS client")
	}
	// Second call should return the cached client (same pointer)
	c2 := r.tlsClientFor(addr)
	if c1 != c2 {
		t.Error("expected tlsClientFor to return cached client on second call")
	}
}

func TestTlsClientFor_InvalidAddress(t *testing.T) {
	mgr := newUpstreamManager(nil, StrategyFailover, 0, 0, 0, false)
	r := &Resolver{upstreamMgr: mgr}

	// Address without port causes net.SplitHostPort to fail — should return nil
	c := r.tlsClientFor("tls://nodotport")
	if c != nil {
		t.Error("expected nil TLS client for malformed address")
	}
}
