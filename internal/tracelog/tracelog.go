package tracelog

import (
	"log/slog"
	"sync"
	"sync/atomic"
)

// Event names for trace logging. Enable via config or runtime API.
const (
	EventRefreshUpstream  = "refresh_upstream"  // Background refresh requests to upstream DNS
	EventQueryResolution  = "query_resolution"  // Full query path: outcome (local, cached, stale, blocked, etc.)
	EventUpstreamExchange = "upstream_exchange" // Client-initiated upstream queries: selected upstream, retries
)

// AllEvents lists all available trace event names for validation and UI.
var AllEvents = []string{
	EventRefreshUpstream,
	EventQueryResolution,
	EventUpstreamExchange,
}

// Events holds the set of enabled trace event names, updatable at runtime.
// Uses atomic.Value for lock-free reads on the hot path (Enabled/Trace when disabled).
type Events struct {
	mu sync.Mutex
	m  atomic.Value // map[string]bool, never nil
}

// New creates a TraceEvents with the given initial event names enabled.
func New(initial []string) *Events {
	e := &Events{}
	e.store(initial)
	return e
}

func (e *Events) store(events []string) {
	m := make(map[string]bool)
	for _, name := range events {
		if isValidEvent(name) {
			m[name] = true
		}
	}
	e.m.Store(m)
}

func isValidEvent(name string) bool {
	for _, valid := range AllEvents {
		if name == valid {
			return true
		}
	}
	return false
}

// Enabled returns true if the given event is enabled for tracing.
// Lock-free: safe to call on every request without mutex overhead.
func (e *Events) Enabled(event string) bool {
	if e == nil {
		return false
	}
	v := e.m.Load()
	if v == nil {
		return false
	}
	return v.(map[string]bool)[event]
}

// Set replaces the set of enabled events. Invalid names are ignored.
func (e *Events) Set(events []string) {
	if e == nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.store(events)
}

// Get returns a copy of the currently enabled event names.
func (e *Events) Get() []string {
	if e == nil {
		return nil
	}
	v := e.m.Load()
	if v == nil {
		return nil
	}
	m := v.(map[string]bool)
	if len(m) == 0 {
		return nil
	}
	out := make([]string, 0, len(m))
	for name := range m {
		out = append(out, name)
	}
	return out
}

// Trace logs at debug level if the event is enabled. Use for high-volume trace events
// that can be toggled at runtime without restart.
func Trace(events *Events, logger *slog.Logger, event, msg string, args ...any) {
	if events == nil || logger == nil || !events.Enabled(event) {
		return
	}
	logger.Log(nil, slog.LevelDebug, msg, args...)
}
