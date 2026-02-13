package clientid

import "testing"

func TestResolver_Resolve(t *testing.T) {
	r := New(map[string]string{
		"192.168.1.10": "kids-phone",
		"192.168.1.11": "laptop",
	})

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

func TestResolver_ApplyConfig(t *testing.T) {
	r := New(map[string]string{"1.2.3.4": "old"})
	if r.Resolve("1.2.3.4") != "old" {
		t.Fatal("initial resolve failed")
	}
	r.ApplyConfig(map[string]string{"1.2.3.4": "new", "5.6.7.8": "other"})
	if r.Resolve("1.2.3.4") != "new" {
		t.Errorf("after apply: Resolve(1.2.3.4) = %q, want new", r.Resolve("1.2.3.4"))
	}
	if r.Resolve("5.6.7.8") != "other" {
		t.Errorf("after apply: Resolve(5.6.7.8) = %q, want other", r.Resolve("5.6.7.8"))
	}
}
