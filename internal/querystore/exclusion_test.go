package querystore

import (
	"testing"
)

func TestExclusionFilter_Domains(t *testing.T) {
	f := NewExclusionFilter(
		[]string{"example.com", "local", "*.example.net", "/^internal\\./"},
		nil,
	)
	if f == nil {
		t.Fatal("expected non-nil filter with domains")
	}

	tests := []struct {
		qname    string
		excluded bool
	}{
		{"example.com", true},
		{"www.example.com", true},
		{"sub.www.example.com", true},
		{"example.org", false},
		{"local", true},
		{"host.local", true},
		{"example.net", true},       // *.example.net normalizes to example.net
		{"pm2.example.net", true},   // *.example.net matches subdomains
		{"api.example.net", true},
		{"internal.service", true},
		{"internal", false},
		{"external.internal.com", false},
		{"other.com", false},
	}
	for _, tt := range tests {
		got := f.Excluded(tt.qname, "1.2.3.4", "")
		if got != tt.excluded {
			t.Errorf("Excluded(%q, ...) = %v, want %v", tt.qname, got, tt.excluded)
		}
	}
}

func TestExclusionFilter_Clients(t *testing.T) {
	f := NewExclusionFilter(
		nil,
		[]string{"192.168.1.10", "kids-phone", "10.0.0.1"},
	)
	if f == nil {
		t.Fatal("expected non-nil filter with clients")
	}

	tests := []struct {
		clientIP   string
		clientName string
		excluded   bool
	}{
		{"192.168.1.10", "", true},
		{"192.168.1.10", "kids-phone", true},
		{"192.168.1.11", "kids-phone", true},
		{"10.0.0.1", "", true},
		{"192.168.1.20", "laptop", false},
		{"192.168.1.20", "Kids-Phone", true}, // case-insensitive
	}
	for _, tt := range tests {
		got := f.Excluded("example.com", tt.clientIP, tt.clientName)
		if got != tt.excluded {
			t.Errorf("Excluded(..., %q, %q) = %v, want %v", tt.clientIP, tt.clientName, got, tt.excluded)
		}
	}
}

func TestExclusionFilter_Empty(t *testing.T) {
	f := NewExclusionFilter(nil, nil)
	if f != nil {
		t.Errorf("expected nil filter for empty lists, got %v", f)
	}
	if f != nil && f.Excluded("example.com", "1.2.3.4", "") {
		t.Error("nil filter should not exclude")
	}
}

func TestExclusionFilter_Update(t *testing.T) {
	f := NewExclusionFilter([]string{"old.com"}, nil)
	if f == nil {
		t.Fatal("expected non-nil filter")
	}
	if !f.Excluded("old.com", "1.2.3.4", "") {
		t.Error("old.com should be excluded")
	}

	f.Update([]string{"new.com"}, nil)
	if f.Excluded("old.com", "1.2.3.4", "") {
		t.Error("old.com should not be excluded after update")
	}
	if !f.Excluded("new.com", "1.2.3.4", "") {
		t.Error("new.com should be excluded after update")
	}
}

func TestExclusionFilter_Update_ClearToEmpty(t *testing.T) {
	f := NewExclusionFilter([]string{"a.com"}, []string{"192.168.1.1"})
	if f == nil {
		t.Fatal("expected non-nil filter")
	}
	if !f.Excluded("a.com", "192.168.1.1", "") {
		t.Error("should exclude before update")
	}

	// Update with empty lists clears the filter
	f.Update(nil, nil)
	if f.Excluded("a.com", "192.168.1.1", "") {
		t.Error("should not exclude after clearing")
	}
}

func TestExclusionFilter_Update_ClientChange(t *testing.T) {
	f := NewExclusionFilter(nil, []string{"client-a"})
	if f == nil {
		t.Fatal("expected non-nil filter")
	}
	if !f.Excluded("x.com", "1.2.3.4", "client-a") {
		t.Error("client-a should be excluded")
	}

	f.Update(nil, []string{"client-b"})
	if f.Excluded("x.com", "1.2.3.4", "client-a") {
		t.Error("client-a should not be excluded after update")
	}
	if !f.Excluded("x.com", "1.2.3.4", "client-b") {
		t.Error("client-b should be excluded after update")
	}
}

func TestExclusionFilter_Update_NilFilterNoOp(t *testing.T) {
	var f *ExclusionFilter
	// Should not panic
	f.Update([]string{"x.com"}, []string{"1.2.3.4"})
}
