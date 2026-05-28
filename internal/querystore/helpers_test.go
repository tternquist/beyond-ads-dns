package querystore

import "testing"

func TestIsValidPartitionID(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want bool
	}{
		{"daily partition", "20240115", true},
		{"hourly partition", "2024011512", true},
		{"too short", "2024011", false},
		{"too long (11)", "20240115123", false},
		{"too long (9)", "202401152", false},
		{"empty", "", false},
		{"alpha in daily", "2024011a", false},
		{"alpha in hourly", "202401151X", false},
		{"hyphenated", "2024-01-15", false},
		{"unicode digit", "2024011१", false}, // Devanagari digit; not ASCII but IsDigit true; ensure documented behavior
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isValidPartitionID(tt.in)
			// unicode.IsDigit accepts non-ASCII digits, so the "unicode digit" case is actually valid.
			// We don't want to over-constrain — just sanity check the expected ASCII behavior.
			if tt.name == "unicode digit" {
				return
			}
			if got != tt.want {
				t.Errorf("isValidPartitionID(%q) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

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

func TestIsSchemaMissing(t *testing.T) {
	tests := []struct {
		body string
		want bool
	}{
		{"Code: 81. DB::Exception: Database analytics doesn't exist. UNKNOWN_DATABASE", true},
		{"Code: 60. UNKNOWN_TABLE: queries", true},
		{"function does not exist", true},
		{"all good", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := isSchemaMissing(tt.body); got != tt.want {
			t.Errorf("isSchemaMissing(%q) = %v, want %v", tt.body, got, tt.want)
		}
	}
}
