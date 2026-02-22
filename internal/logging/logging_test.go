package logging

import (
	"bytes"
	"io"
	"log/slog"
	"strings"
	"testing"
)

func TestParseLevel(t *testing.T) {
	tests := []struct {
		input string
		want  slog.Level
	}{
		{"debug", slog.LevelDebug},
		{"DEBUG", slog.LevelDebug},
		{"  debug  ", slog.LevelDebug},
		{"info", slog.LevelInfo},
		{"Info", slog.LevelInfo},
		{"warn", slog.LevelWarn},
		{"warning", slog.LevelWarn},
		{"WARN", slog.LevelWarn},
		{"WARNING", slog.LevelWarn},
		{"error", slog.LevelError},
		{"ERROR", slog.LevelError},
		{"", slog.LevelWarn},
		{"invalid", slog.LevelWarn},
		{"unknown", slog.LevelWarn},
	}
	for _, tt := range tests {
		got := ParseLevel(tt.input)
		if got != tt.want {
			t.Errorf("ParseLevel(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestNewLogger_TextFormat(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger(&buf, Config{Format: "text", Level: "info"})
	if logger == nil {
		t.Fatal("expected non-nil logger")
	}
	logger.Info("test message")
	out := buf.String()
	if !strings.Contains(out, "test message") {
		t.Errorf("expected 'test message' in output, got %q", out)
	}
	if !strings.Contains(out, "level=INFO") {
		t.Errorf("expected level=INFO in text output, got %q", out)
	}
}

func TestNewLogger_JSONFormat(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger(&buf, Config{Format: "json", Level: "debug"})
	if logger == nil {
		t.Fatal("expected non-nil logger")
	}
	logger.Debug("json test")
	out := buf.String()
	if !strings.Contains(out, "json test") {
		t.Errorf("expected 'json test' in output, got %q", out)
	}
	if !strings.Contains(out, "\"level\":\"DEBUG\"") && !strings.Contains(out, "\"level\":\"debug\"") {
		t.Errorf("expected level in JSON output, got %q", out)
	}
}

func TestNewLogger_EmptyLevelDefaultsToWarn(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger(&buf, Config{Format: "text", Level: ""})
	if logger == nil {
		t.Fatal("expected non-nil logger")
	}
	logger.Debug("should not appear")
	logger.Warn("should appear")
	out := buf.String()
	if strings.Contains(out, "should not appear") {
		t.Error("debug message should not appear when level is warn")
	}
	if !strings.Contains(out, "should appear") {
		t.Error("warn message should appear")
	}
}

func TestNewLogger_UnknownFormatDefaultsToText(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger(&buf, Config{Format: "xml", Level: "info"})
	if logger == nil {
		t.Fatal("expected non-nil logger")
	}
	logger.Info("fallback")
	out := buf.String()
	if !strings.Contains(out, "fallback") {
		t.Errorf("expected message in output, got %q", out)
	}
}

func TestNewDefaultLogger(t *testing.T) {
	var buf bytes.Buffer
	logger := NewDefaultLogger(&buf)
	if logger == nil {
		t.Fatal("expected non-nil logger")
	}
	logger.Warn("default test")
	out := buf.String()
	if !strings.Contains(out, "default test") {
		t.Errorf("expected 'default test' in output, got %q", out)
	}
}

func TestNewDiscardLogger(t *testing.T) {
	logger := NewDiscardLogger()
	if logger == nil {
		t.Fatal("expected non-nil logger")
	}
	// Should not panic when logging
	logger.Info("discarded")
	logger.Debug("discarded")
}

func TestNewLogger_WritesToWriter(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger(&buf, Config{Format: "text", Level: "info"})
	logger.Info("msg", "key", "value")
	if buf.Len() == 0 {
		t.Error("expected output to be written")
	}
}

func TestNewLogger_AcceptsDiscard(t *testing.T) {
	logger := NewLogger(io.Discard, Config{Format: "text", Level: "info"})
	if logger == nil {
		t.Fatal("expected non-nil logger")
	}
	logger.Info("to discard")
}
