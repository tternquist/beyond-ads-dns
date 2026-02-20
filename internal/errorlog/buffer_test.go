package errorlog

import (
	"bytes"
	"io"
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

func TestErrorBuffer_MinLevel(t *testing.T) {
	for _, level := range []string{"error", "warning", "info", "debug"} {
		b := NewBuffer(io.Discard, 10, level, nil, nil)
		if got := b.MinLevel(); got != level {
			t.Errorf("MinLevel() with %q = %q, want %q", level, got, level)
		}
	}
	// Invalid level defaults to warning
	b := NewBuffer(io.Discard, 10, "invalid", nil, nil)
	if got := b.MinLevel(); got != "warning" {
		t.Errorf("MinLevel() with invalid = %q, want \"warning\"", got)
	}
	// Nil receiver
	var nilBuf *ErrorBuffer
	if got := nilBuf.MinLevel(); got != "warning" {
		t.Errorf("nil MinLevel() = %q, want \"warning\"", got)
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
		{"debug: cache key cleaned up (below sweep_min_hits threshold): 5 keys removed", SeverityDebug},
		{"beyond-ads-dns 2025/02/15 12:00:00 debug: sync: config applied successfully", SeverityDebug},
		{"info: query store buffer full; 12000 events dropped total", SeverityInfo},
		{"warning: blocklist source \"hagezi\" returned status 404", SeverityWarning},
		{"warning: refresh got SERVFAIL for example.com, backing off", SeverityWarning},
		{"listening on 0.0.0.0:53", ""},
		{"config applied successfully", ""},
		// slog JSON format
		{`{"time":"2026-02-18T12:00:00Z","level":"ERROR","msg":"sync: blocklist reload error","err":"refused"}`, SeverityError},
		{`{"time":"2026-02-18T12:00:00Z","level":"WARN","msg":"cache hit counter failed"}`, SeverityWarning},
		// slog text format
		{`time=2026-02-18T12:00:00Z level=ERROR msg="sync: blocklist reload error" err=refused`, SeverityError},
		{`time=2026-02-18T12:00:00Z level=INFO msg="sync: config applied successfully"`, SeverityInfo},
	}
	for _, tt := range tests {
		got := classifyLine(tt.line)
		if got != tt.severity {
			t.Errorf("classifyLine(%q) = %q, want %q", tt.line, got, tt.severity)
		}
	}
}

func TestErrorBuffer_LogLevel(t *testing.T) {
	// minLevel "error": only errors buffered and output to stdout
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
		// Stdout should only contain error line, not info or warning
		outStr := out.String()
		if strings.Contains(outStr, "info: cache key") {
			t.Errorf("log_level=error: info line should not appear in stdout")
		}
		if strings.Contains(outStr, "cache hit counter failed") {
			t.Errorf("log_level=error: warning line should not appear in stdout")
		}
		if !strings.Contains(outStr, "control server error") {
			t.Errorf("log_level=error: error line should appear in stdout")
		}
	}
	// minLevel "warning": errors and warnings buffered and output; info filtered from stdout
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
		outStr := out.String()
		if strings.Contains(outStr, "info: cache key") {
			t.Errorf("log_level=warning: info line should not appear in stdout")
		}
		if !strings.Contains(outStr, "cache hit counter failed") {
			t.Errorf("log_level=warning: warning line should appear in stdout")
		}
		if !strings.Contains(outStr, "control server error") {
			t.Errorf("log_level=warning: error line should appear in stdout")
		}
	}
	// minLevel "info": errors, warnings, info buffered and output; debug filtered from stdout
	{
		var out bytes.Buffer
		b := NewBuffer(&out, 10, "info", nil, nil)
		_, _ = b.Write([]byte("info: cache key cleaned up\n"))
		_, _ = b.Write([]byte("debug: sync: config applied\n"))
		_, _ = b.Write([]byte("cache hit counter failed: timeout\n"))
		_, _ = b.Write([]byte("control server error: refused\n"))
		entries := b.ErrorsEntries()
		if len(entries) != 3 {
			t.Errorf("log_level=info: expected 3 entries (no debug), got %d", len(entries))
		}
		outStr := out.String()
		if !strings.Contains(outStr, "info: cache key") {
			t.Errorf("log_level=info: info line should appear in stdout")
		}
		if strings.Contains(outStr, "debug: sync") {
			t.Errorf("log_level=info: debug line should not appear in stdout")
		}
		if !strings.Contains(outStr, "cache hit counter failed") {
			t.Errorf("log_level=info: warning line should appear in stdout")
		}
		if !strings.Contains(outStr, "control server error") {
			t.Errorf("log_level=info: error line should appear in stdout")
		}
	}
	// minLevel "debug": all buffered and output
	{
		var out bytes.Buffer
		b := NewBuffer(&out, 10, "debug", nil, nil)
		_, _ = b.Write([]byte("info: cache key cleaned up\n"))
		_, _ = b.Write([]byte("debug: sync: config applied\n"))
		_, _ = b.Write([]byte("cache hit counter failed: timeout\n"))
		_, _ = b.Write([]byte("control server error: refused\n"))
		entries := b.ErrorsEntries()
		if len(entries) != 4 {
			t.Errorf("log_level=debug: expected 4 entries, got %d", len(entries))
		}
		outStr := out.String()
		if !strings.Contains(outStr, "debug: sync") {
			t.Errorf("log_level=debug: debug line should appear in stdout")
		}
		if !strings.Contains(outStr, "info: cache key") {
			t.Errorf("log_level=debug: info line should appear in stdout")
		}
	}
}
