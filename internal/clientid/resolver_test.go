package clientid

import "testing"

func TestResolver_Resolve(t *testing.T) {
	r := New(map[string]string{
		"192.168.1.10": "kids-phone",
		"192.168.1.11": "laptop",
	}, nil)

	tests := []struct {
		ip   string
		want string
	}{
		{"192.168.1.10", "kids-phone"},
		{"192.168.1.11", "laptop"},
		{"192.168.1.12", "192.168.1.12"},
		{"10.0.0.1", "10.0.0.1"},
		{"192.168.1.10:12345", "kids-phone"},
		{"", ""},
	}
	for _, tt := range tests {
		got := r.Resolve(tt.ip)
		if got != tt.want {
			t.Errorf("Resolve(%q) = %q, want %q", tt.ip, got, tt.want)
		}
	}
}

func TestResolver_ResolveGroup(t *testing.T) {
	r := New(
		map[string]string{"192.168.1.10": "kids-phone"},
		map[string]string{"192.168.1.10": "kids"},
	)
	if got := r.ResolveGroup("192.168.1.10"); got != "kids" {
		t.Errorf("ResolveGroup(192.168.1.10) = %q, want kids", got)
	}
	if got := r.ResolveGroup("192.168.1.11"); got != "" {
		t.Errorf("ResolveGroup(192.168.1.11) = %q, want empty", got)
	}
	// IP with port is normalized
	if got := r.ResolveGroup("192.168.1.10:5353"); got != "kids" {
		t.Errorf("ResolveGroup(192.168.1.10:5353) = %q, want kids", got)
	}
}

func TestResolver_ApplyConfig(t *testing.T) {
	r := New(map[string]string{"1.2.3.4": "old"}, nil)
	if r.Resolve("1.2.3.4") != "old" {
		t.Fatal("initial resolve failed")
	}
	r.ApplyConfig(map[string]string{"1.2.3.4": "new", "5.6.7.8": "other"}, nil)
	if r.Resolve("1.2.3.4") != "new" {
		t.Errorf("after apply: Resolve(1.2.3.4) = %q, want new", r.Resolve("1.2.3.4"))
	}
	if r.Resolve("5.6.7.8") != "other" {
		t.Errorf("after apply: Resolve(5.6.7.8) = %q, want other", r.Resolve("5.6.7.8"))
	}
}

func TestResolver_ApplyConfig_WithGroups(t *testing.T) {
	r := New(
		map[string]string{"1.2.3.4": "device1"},
		map[string]string{"1.2.3.4": "group-a"},
	)
	if r.ResolveGroup("1.2.3.4") != "group-a" {
		t.Fatalf("initial ResolveGroup = %q, want group-a", r.ResolveGroup("1.2.3.4"))
	}
	// Apply new config with different groups
	r.ApplyConfig(
		map[string]string{"1.2.3.4": "device1", "5.6.7.8": "device2"},
		map[string]string{"1.2.3.4": "group-b", "5.6.7.8": "group-b"},
	)
	if r.ResolveGroup("1.2.3.4") != "group-b" {
		t.Errorf("after apply: ResolveGroup(1.2.3.4) = %q, want group-b", r.ResolveGroup("1.2.3.4"))
	}
	if r.ResolveGroup("5.6.7.8") != "group-b" {
		t.Errorf("after apply: ResolveGroup(5.6.7.8) = %q, want group-b", r.ResolveGroup("5.6.7.8"))
	}
	// ApplyConfig with nil groups clears groups
	r.ApplyConfig(map[string]string{"1.2.3.4": "device1"}, nil)
	if r.ResolveGroup("1.2.3.4") != "" {
		t.Errorf("after apply nil groups: ResolveGroup = %q, want empty", r.ResolveGroup("1.2.3.4"))
	}
}

func TestResolver_New_NilInputs(t *testing.T) {
	r := New(nil, nil)
	if r.Resolve("1.2.3.4") != "1.2.3.4" {
		t.Errorf("Resolve with nil clients should return IP, got %q", r.Resolve("1.2.3.4"))
	}
	if r.ResolveGroup("1.2.3.4") != "" {
		t.Errorf("ResolveGroup with nil groups should return empty, got %q", r.ResolveGroup("1.2.3.4"))
	}
}
