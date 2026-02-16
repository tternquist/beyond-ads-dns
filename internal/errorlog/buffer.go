package errorlog

import (
	"bytes"
	"io"
	"strings"
	"sync"
	"time"
)

// OnErrorAdded is an optional callback invoked when a new error line is added to the buffer.
// Used to route errors to the error webhook.
type OnErrorAdded func(message string)

// ErrorBuffer is an io.Writer that forwards all output to an underlying writer
// while parsing and buffering lines that appear to be error or warning messages.
// Used with log.Logger to capture application errors for the control API.
// Only error-level entries trigger the onErrorAdded callback (webhook).
type ErrorBuffer struct {
	underlying   io.Writer
	maxErrors    int
	minLevel     SeverityLevel // minimum severity to buffer: error, warning, or info
	mu           sync.RWMutex
	entries      []ErrorEntry
	partial      []byte
	onErrorAdded OnErrorAdded
	persister    *Persister
}

// NewBuffer creates an ErrorBuffer that forwards to w and keeps up to maxErrors recent error lines.
// minLevel is the minimum severity to buffer: "error" (only errors), "warning" (errors+warnings), or "info" (all).
// onErrorAdded is an optional callback invoked when a new error is added (e.g. to fire the error webhook).
// persistenceCfg is optional; when non-nil, errors are persisted to disk with configurable retention.
func NewBuffer(w io.Writer, maxErrors int, minLevel string, onErrorAdded OnErrorAdded, persistenceCfg *PersistenceConfig) *ErrorBuffer {
	if maxErrors <= 0 {
		maxErrors = 100
	}
	ml := SeverityLevel(strings.ToLower(strings.TrimSpace(minLevel)))
	if ml != SeverityError && ml != SeverityWarning && ml != SeverityInfo {
		ml = SeverityWarning
	}
	b := &ErrorBuffer{
		underlying:   w,
		maxErrors:    maxErrors,
		minLevel:     ml,
		entries:      make([]ErrorEntry, 0, maxErrors),
		onErrorAdded: onErrorAdded,
	}
	if persistenceCfg != nil {
		if p, err := NewPersister(*persistenceCfg); err == nil {
			b.persister = p
		}
	}
	return b
}

// Write implements io.Writer. It forwards data to the underlying writer and
// buffers lines that match error or warning patterns.
// Warnings (lines containing "warning") are buffered but do not trigger the webhook.
func (b *ErrorBuffer) Write(p []byte) (n int, err error) {
	n, err = b.underlying.Write(p)
	if err != nil {
		return n, err
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	b.partial = append(b.partial, p...)
	lines := bytes.Split(b.partial, []byte{'\n'})
	b.partial = lines[len(lines)-1]
	lines = lines[:len(lines)-1]

	for _, line := range lines {
		s := strings.TrimSpace(string(line))
		if s == "" {
			continue
		}
		if sev := classifyLine(s); sev != "" && b.shouldBuffer(sev) {
			b.addEntry(s, sev)
		}
	}

	return n, nil
}

// classifyLine returns SeverityInfo, SeverityWarning, SeverityError, or "" if the line should not be buffered.
// Check error before warning so "error: more info: ..." is classified as error.
// Check warning before info so "sync: warning - pull failed" is classified as warning.
// "cache hit counter failed" is non-fatal (e.g. context deadline) and treated as warning.
// Info messages use "info: " prefix (e.g. "info: cache key cleaned up").
func classifyLine(s string) SeverityLevel {
	lower := strings.ToLower(s)
	if strings.Contains(lower, "cache hit counter failed") || strings.Contains(lower, "sweep hit counter failed") {
		return SeverityWarning
	}
	if strings.Contains(lower, "warning") {
		return SeverityWarning
	}
	if strings.Contains(lower, "error") ||
		strings.Contains(lower, "failed") ||
		strings.Contains(lower, "fail:") ||
		strings.Contains(lower, "panic") ||
		strings.Contains(lower, "fatal") {
		return SeverityError
	}
	if strings.Contains(lower, "info:") {
		return SeverityInfo
	}
	return ""
}

// shouldBuffer returns true if the given severity meets the minimum log level.
// Order: error (most severe) > warning > info (least severe).
func (b *ErrorBuffer) shouldBuffer(sev SeverityLevel) bool {
	switch b.minLevel {
	case SeverityError:
		return sev == SeverityError
	case SeverityWarning:
		return sev == SeverityError || sev == SeverityWarning
	case SeverityInfo:
		return true
	default:
		return sev == SeverityError || sev == SeverityWarning
	}
}

func (b *ErrorBuffer) addEntry(s string, severity SeverityLevel) {
	entry := ErrorEntry{
		Message:   s,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Severity:  severity,
	}
	b.entries = append(b.entries, entry)
	if len(b.entries) > b.maxErrors {
		b.entries = b.entries[len(b.entries)-b.maxErrors:]
	}
	if b.persister != nil {
		_ = b.persister.Append(s, severity)
	}
	if severity == SeverityError && b.onErrorAdded != nil {
		b.onErrorAdded(s)
	}
}

// SetOnErrorAdded sets the callback invoked when a new error is added.
// Safe to call after creation; used when the webhook is configured after config load.
func (b *ErrorBuffer) SetOnErrorAdded(f OnErrorAdded) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onErrorAdded = f
}

// Errors returns a copy of the buffered error message strings (for backward compat).
// Prefer ErrorsEntries for entries with severity and timestamps.
func (b *ErrorBuffer) Errors() []string {
	entries := b.ErrorsEntries()
	if len(entries) == 0 {
		return nil
	}
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Message
	}
	return out
}

// ErrorsEntries returns all buffered entries (errors and warnings) with timestamps and severity.
// When persistence is enabled, returns entries from disk; otherwise from in-memory buffer.
func (b *ErrorBuffer) ErrorsEntries() []ErrorEntry {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.persister != nil {
		return b.persister.Entries()
	}
	if len(b.entries) == 0 {
		return nil
	}
	out := make([]ErrorEntry, len(b.entries))
	copy(out, b.entries)
	return out
}

// Close closes any persistence file handle. Call before process exit if using persistence.
func (b *ErrorBuffer) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.persister != nil {
		return b.persister.Close()
	}
	return nil
}
