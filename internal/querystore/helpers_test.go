package querystore

import "testing"

func TestIsValidIdentifier(t *testing.T) {
	tests := []struct {
		in   string
		want bool
	}{
		{"valid", true},
		{"valid_with_underscore", true},
		{"VALID123", true},
		{"  spaces_trimmed  ", true},
		{"", false},
		{"   ", false},
		{"has-dash", false},
		{"has space", false},
		{"semicolons;drop", false},
		{"backtick`", false},
	}
	for _, tt := range tests {
		if got := isValidIdentifier(tt.in); got != tt.want {
			t.Errorf("isValidIdentifier(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
	// Length limit (>256) rejected.
	long := make([]byte, 300)
	for i := range long {
		long[i] = 'a'
	}
	if isValidIdentifier(string(long)) {
		t.Errorf("isValidIdentifier(300 chars) = true, want false")
	}
}
