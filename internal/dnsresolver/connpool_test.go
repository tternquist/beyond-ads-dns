package dnsresolver

import (
	"errors"
	"io"
	"testing"
)

func TestIsRetriableError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"EOF", io.EOF, true},
		{"wrapped EOF", errors.Join(io.EOF), true},
		{"write error", errors.New("write: broken pipe"), true},
		{"connection reset", errors.New("read tcp: connection reset by peer"), true},
		{"connection refused", errors.New("dial tcp: connection refused"), true},
		{"closed network", errors.New("use of closed network connection"), true},
		{"timeout", errors.New("i/o timeout"), false},
		{"generic", errors.New("something else"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isRetriableError(tt.err)
			if got != tt.want {
				t.Errorf("isRetriableError(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}
