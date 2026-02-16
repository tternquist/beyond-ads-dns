package errorlog

import (
	"bytes"
	"strings"
	"testing"
)

func TestErrorBuffer_Write(t *testing.T) {
	var out bytes.Buffer
	b := NewBuffer(&out, 5, "warning", nil, nil)

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

func TestErrorBuffer_ClassifyLine(t *testing.T) {
	tests := []struct {
		line     string
		severity SeverityLevel
	}{
		{"control server error: connection refused", SeverityError},
		{"sync: pull failed: timeout", SeverityError},
		{"blocklist refresh failed: test", SeverityError},
		{"panic: runtime error", SeverityError},
		{"fatal: something", SeverityError},
		{"sync: pull error (will retry): timeout", SeverityError},
		{"sync: blocklist reload error: connection refused", SeverityError},
		{"cache hit counter failed: context deadline exceeded", SeverityWarning},
		{"info: cache key cleaned up (below sweep_min_hits threshold): 5 keys removed", SeverityInfo},
		{"beyond-ads-dns 2025/02/15 12:00:00 info: cache key cleaned up (below sweep_min_hits threshold): 3 keys removed", SeverityInfo},
		{"info: query store buffer full; 12000 events dropped total", SeverityInfo},
		{"warning: blocklist source \"hagezi\" returned status 404", SeverityWarning},
		{"warning: refresh got SERVFAIL for example.com, backing off", SeverityWarning},
		{"listening on 0.0.0.0:53", ""},
		{"config applied successfully", ""},
	}
	for _, tt := range tests {
		got := classifyLine(tt.line)
		if got != tt.severity {
			t.Errorf("classifyLine(%q) = %q, want %q", tt.line, got, tt.severity)
		}
	}
}

func TestErrorBuffer_LogLevel(t *testing.T) {
	// minLevel "error": only errors buffered
	{
		var out bytes.Buffer
		b := NewBuffer(&out, 10, "error", nil, nil)
		_, _ = b.Write([]byte("info: cache key cleaned up\n"))
		_, _ = b.Write([]byte("cache hit counter failed: timeout\n"))
		_, _ = b.Write([]byte("control server error: refused\n"))
		entries := b.ErrorsEntries()
		if len(entries) != 1 {
			t.Errorf("log_level=error: expected 1 entry, got %d", len(entries))
		}
		if entries[0].Severity != SeverityError {
			t.Errorf("log_level=error: expected severity error, got %q", entries[0].Severity)
		}
	}
	// minLevel "warning": errors and warnings buffered
	{
		var out bytes.Buffer
		b := NewBuffer(&out, 10, "warning", nil, nil)
		_, _ = b.Write([]byte("info: cache key cleaned up\n"))
		_, _ = b.Write([]byte("cache hit counter failed: timeout\n"))
		_, _ = b.Write([]byte("control server error: refused\n"))
		entries := b.ErrorsEntries()
		if len(entries) != 2 {
			t.Errorf("log_level=warning: expected 2 entries, got %d", len(entries))
		}
	}
	// minLevel "info": all buffered
	{
		var out bytes.Buffer
		b := NewBuffer(&out, 10, "info", nil, nil)
		_, _ = b.Write([]byte("info: cache key cleaned up\n"))
		_, _ = b.Write([]byte("cache hit counter failed: timeout\n"))
		_, _ = b.Write([]byte("control server error: refused\n"))
		entries := b.ErrorsEntries()
		if len(entries) != 3 {
			t.Errorf("log_level=info: expected 3 entries, got %d", len(entries))
		}
	}
}
