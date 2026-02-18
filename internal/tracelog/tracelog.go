package tracelog

import (
	"log/slog"
	"sync"
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
type Events struct {
	mu     sync.RWMutex
	events map[string]bool
}

// New creates a TraceEvents with the given initial event names enabled.
func New(initial []string) *Events {
	e := &Events{events: make(map[string]bool)}
	if len(initial) > 0 {
		for _, name := range initial {
			if isValidEvent(name) {
				e.events[name] = true
			}
		}
	}
	return e
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
func (e *Events) Enabled(event string) bool {
	if e == nil {
		return false
	}
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.events[event]
}

// Set replaces the set of enabled events. Invalid names are ignored.
func (e *Events) Set(events []string) {
	if e == nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.events = make(map[string]bool)
	for _, name := range events {
		if isValidEvent(name) {
			e.events[name] = true
		}
	}
}

// Get returns a copy of the currently enabled event names.
func (e *Events) Get() []string {
	if e == nil {
		return nil
	}
	e.mu.RLock()
	defer e.mu.RUnlock()
	if len(e.events) == 0 {
		return nil
	}
	out := make([]string, 0, len(e.events))
	for name := range e.events {
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
