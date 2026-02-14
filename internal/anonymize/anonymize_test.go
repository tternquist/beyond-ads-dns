package anonymize

import (
	"testing"
)

func TestIP(t *testing.T) {
	tests := []struct {
		ip   string
		mode string
		want string
	}{
		{"192.168.1.100", "none", "192.168.1.100"},
		{"192.168.1.100", "", "192.168.1.100"},
		{"192.168.1.100", "truncate", "192.168.1.0"},
		{"2001:db8::1", "truncate", "2001:db8::"},
		{"192.168.1.100", "hash", ""}, // hash is non-empty, we just check it's different
	}
	for _, tt := range tests {
		got := IP(tt.ip, tt.mode)
		if tt.mode == "hash" {
			if len(got) != 16 {
				t.Errorf("IP(%q, %q) hash len = %d, want 16", tt.ip, tt.mode, len(got))
			}
			if got == tt.ip {
				t.Errorf("IP(%q, hash) should not return original IP", tt.ip)
			}
			continue
		}
		if got != tt.want {
			t.Errorf("IP(%q, %q) = %q, want %q", tt.ip, tt.mode, got, tt.want)
		}
	}
}

func TestIPHashDeterministic(t *testing.T) {
	a := IP("10.0.0.1", "hash")
	b := IP("10.0.0.1", "hash")
	if a != b {
		t.Errorf("hash should be deterministic: %q != %q", a, b)
	}
}
