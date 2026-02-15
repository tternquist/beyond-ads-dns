package errorlog

import (
	"bytes"
	"io"
	"strings"
	"sync"
)

// OnErrorAdded is an optional callback invoked when a new error line is added to the buffer.
// Used to route errors to the error webhook.
type OnErrorAdded func(message string)

// ErrorBuffer is an io.Writer that forwards all output to an underlying writer
// while parsing and buffering lines that appear to be error messages.
// Used with log.Logger to capture application errors for the control API.
type ErrorBuffer struct {
	underlying   io.Writer
	maxErrors    int
	mu           sync.RWMutex
	errors       []string
	partial      []byte
	onErrorAdded OnErrorAdded
	persister    *Persister
}

// NewBuffer creates an ErrorBuffer that forwards to w and keeps up to maxErrors recent error lines.
// onErrorAdded is an optional callback invoked when a new error is added (e.g. to fire the error webhook).
// persistenceCfg is optional; when non-nil, errors are persisted to disk with configurable retention.
func NewBuffer(w io.Writer, maxErrors int, onErrorAdded OnErrorAdded, persistenceCfg *PersistenceConfig) *ErrorBuffer {
	if maxErrors <= 0 {
		maxErrors = 100
	}
	b := &ErrorBuffer{
		underlying:   w,
		maxErrors:    maxErrors,
		errors:       make([]string, 0, maxErrors),
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
// buffers lines that match error patterns (error, failed, fail, panic, fatal).
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
		if s != "" && isErrorLine(s) {
			b.addError(s)
		}
	}

	return n, nil
}

func isErrorLine(s string) bool {
	lower := strings.ToLower(s)
	return strings.Contains(lower, "error") ||
		strings.Contains(lower, "failed") ||
		strings.Contains(lower, "fail:") ||
		strings.Contains(lower, "panic") ||
		strings.Contains(lower, "fatal")
}

func (b *ErrorBuffer) addError(s string) {
	b.errors = append(b.errors, s)
	if len(b.errors) > b.maxErrors {
		b.errors = b.errors[len(b.errors)-b.maxErrors:]
	}
	if b.persister != nil {
		_ = b.persister.Append(s)
	}
	if b.onErrorAdded != nil {
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

// Errors returns a copy of the buffered error lines, newest last.
// When persistence is enabled, returns errors within the retention period from disk.
func (b *ErrorBuffer) Errors() []string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.persister != nil {
		entries := b.persister.Entries()
		if len(entries) == 0 {
			return nil
		}
		out := make([]string, len(entries))
		for i, e := range entries {
			out[i] = e.Message
		}
		return out
	}
	if len(b.errors) == 0 {
		return nil
	}
	out := make([]string, len(b.errors))
	copy(out, b.errors)
	return out
}

// ErrorsEntries returns errors with timestamps when persistence is enabled.
// When persistence is disabled, returns nil.
func (b *ErrorBuffer) ErrorsEntries() []ErrorEntry {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.persister != nil {
		return b.persister.Entries()
	}
	return nil
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
