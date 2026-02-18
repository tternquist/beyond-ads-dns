package logging

import (
	"io"
	"log/slog"
	"os"
	"strings"
)

// Config holds structured logging configuration.
type Config struct {
	// Format: "json" for production/observability, "text" for human-readable (default).
	Format string
	// Level: "debug", "info", "warn", "warning", "error". Default "warning".
	Level string
}

// ParseLevel converts a string level to slog.Level.
func ParseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "info":
		return slog.LevelInfo
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelWarn
	}
}

// NewLogger creates a slog.Logger that writes to w with the given format and level.
// Format "json" produces structured JSON for production; "text" produces human-readable output.
func NewLogger(w io.Writer, cfg Config) *slog.Logger {
	level := ParseLevel(cfg.Level)
	if cfg.Level == "" {
		level = slog.LevelWarn
	}

	var handler slog.Handler
	switch strings.ToLower(strings.TrimSpace(cfg.Format)) {
	case "json":
		handler = slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level})
	default:
		handler = slog.NewTextHandler(w, &slog.HandlerOptions{Level: level})
	}

	return slog.New(handler)
}

// NewDefaultLogger creates a logger with default config (text format, warn level).
func NewDefaultLogger(w io.Writer) *slog.Logger {
	return NewLogger(w, Config{Format: "text", Level: "warning"})
}

// NewDiscardLogger returns a logger that discards all output (for tests).
func NewDiscardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

// Fatal logs and exits. Use sparingly for fatal startup errors.
func Fatal(logger *slog.Logger, msg string, args ...any) {
	if logger != nil {
		logger.Error(msg, args...)
	}
	os.Exit(1)
}
