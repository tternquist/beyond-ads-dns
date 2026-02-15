package errorlog

import (
	"bytes"
	"strings"
	"testing"
)

func TestErrorBuffer_Write(t *testing.T) {
	var out bytes.Buffer
	b := NewBuffer(&out, 5, nil, nil)

	// Non-error line: forwarded but not buffered
	_, _ = b.Write([]byte("2025/02/15 12:00:00 beyond-ads-dns listening on 0.0.0.0:53 (udp)\n"))
	if got := b.Errors(); len(got) != 0 {
		t.Errorf("expected 0 errors, got %d: %v", len(got), got)
	}
	if !strings.Contains(out.String(), "listening") {
		t.Errorf("expected output to contain 'listening', got %q", out.String())
	}

	// Error line: forwarded and buffered
	_, _ = b.Write([]byte("2025/02/15 12:00:01 beyond-ads-dns control server error: connection refused\n"))
	errors := b.Errors()
	if len(errors) != 1 {
		t.Fatalf("expected 1 error, got %d", len(errors))
	}
	if !strings.Contains(errors[0], "error") {
		t.Errorf("expected error to contain 'error', got %q", errors[0])
	}

	// Another error
	_, _ = b.Write([]byte("2025/02/15 12:00:02 beyond-ads-dns sync: pull failed: timeout\n"))
	errors = b.Errors()
	if len(errors) != 2 {
		t.Fatalf("expected 2 errors, got %d", len(errors))
	}

	// Exceeds max: keeps newest
	for i := 0; i < 5; i++ {
		_, _ = b.Write([]byte("2025/02/15 12:00:03 beyond-ads-dns blocklist refresh failed: test\n"))
	}
	errors = b.Errors()
	if len(errors) != 5 {
		t.Errorf("expected 5 errors (max), got %d", len(errors))
	}
}

func TestErrorBuffer_IsErrorLine(t *testing.T) {
	tests := []struct {
		line   string
		isErr  bool
	}{
		{"control server error: connection refused", true},
		{"sync: pull failed: timeout", true},
		{"blocklist refresh failed: test", true},
		{"panic: runtime error", true},
		{"fatal: something", true},
		{"listening on 0.0.0.0:53", false},
		{"config applied successfully", false},
	}
	for _, tt := range tests {
		got := isErrorLine(tt.line)
		if got != tt.isErr {
			t.Errorf("isErrorLine(%q) = %v, want %v", tt.line, got, tt.isErr)
		}
	}
}
