package tracelog

import (
	"bytes"
	"log/slog"
	"testing"
)

func TestEvents_Enabled(t *testing.T) {
	e := New([]string{"refresh_upstream"})
	if !e.Enabled("refresh_upstream") {
		t.Error("refresh_upstream should be enabled")
	}
	if e.Enabled("invalid") {
		t.Error("invalid should not be enabled")
	}
	e.Set([]string{"query_resolution", "upstream_exchange"})
	if !e.Enabled("query_resolution") || !e.Enabled("upstream_exchange") {
		t.Error("query_resolution and upstream_exchange should be enabled")
	}
}

func TestEvents_Set(t *testing.T) {
	e := New(nil)
	e.Set([]string{"refresh_upstream"})
	if !e.Enabled("refresh_upstream") {
		t.Error("after Set: refresh_upstream should be enabled")
	}
	e.Set([]string{})
	if e.Enabled("refresh_upstream") {
		t.Error("after Set([]): refresh_upstream should be disabled")
	}
}

func TestEvents_Get(t *testing.T) {
	e := New([]string{"refresh_upstream"})
	got := e.Get()
	if len(got) != 1 || got[0] != "refresh_upstream" {
		t.Errorf("Get() = %v, want [refresh_upstream]", got)
	}
	e.Set([]string{})
	if got := e.Get(); len(got) != 0 {
		t.Errorf("Get() after clear = %v, want []", got)
	}
}

func TestTrace_LogsWhenEnabled(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	events := New([]string{"refresh_upstream"})
	Trace(events, logger, "refresh_upstream", "test trace", "key", "val")
	if buf.Len() == 0 {
		t.Error("expected trace to log when event enabled")
	}
}

func TestTrace_NoLogWhenDisabled(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	events := New([]string{})
	Trace(events, logger, "refresh_upstream", "test trace", "key", "val")
	if buf.Len() != 0 {
		t.Errorf("expected no log when event disabled, got %q", buf.String())
	}
}

func TestTrace_NilEvents(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	Trace(nil, logger, "refresh_upstream", "test trace", "key", "val")
	if buf.Len() != 0 {
		t.Errorf("expected no log when events nil, got %q", buf.String())
	}
}

func BenchmarkEnabled_Disabled(b *testing.B) {
	events := New([]string{})
	for i := 0; i < b.N; i++ {
		events.Enabled(EventQueryResolution)
	}
}

func BenchmarkEnabled_Enabled(b *testing.B) {
	events := New([]string{EventQueryResolution})
	for i := 0; i < b.N; i++ {
		events.Enabled(EventQueryResolution)
	}
}
