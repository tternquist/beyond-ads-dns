package errorlog

import (
	"bytes"
	"io"
	"strings"
	"sync"
)

// ErrorBuffer is an io.Writer that forwards all output to an underlying writer
// while parsing and buffering lines that appear to be error messages.
// Used with log.Logger to capture application errors for the control API.
type ErrorBuffer struct {
	underlying io.Writer
	maxErrors  int
	mu         sync.RWMutex
	errors     []string
	partial    []byte
}

// NewBuffer creates an ErrorBuffer that forwards to w and keeps up to maxErrors recent error lines.
func NewBuffer(w io.Writer, maxErrors int) *ErrorBuffer {
	if maxErrors <= 0 {
		maxErrors = 100
	}
	return &ErrorBuffer{
		underlying: w,
		maxErrors:  maxErrors,
		errors:     make([]string, 0, maxErrors),
	}
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
}

// Errors returns a copy of the buffered error lines, newest last.
func (b *ErrorBuffer) Errors() []string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if len(b.errors) == 0 {
		return nil
	}
	out := make([]string, len(b.errors))
	copy(out, b.errors)
	return out
}
