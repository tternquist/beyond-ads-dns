package webhook

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestAppendContextFieldsSkipsEmpty(t *testing.T) {
	base := []map[string]any{{"name": "Existing", "value": "v", "inline": true}}
	got := appendContextFields(base, nil)
	if len(got) != 1 {
		t.Errorf("nil context should not add fields, got %d", len(got))
	}
	got = appendContextFields(base, map[string]any{})
	if len(got) != 1 {
		t.Errorf("empty context should not add fields, got %d", len(got))
	}
}

func TestAppendContextFieldsSortedDeterministic(t *testing.T) {
	ctx := map[string]any{
		"zebra": "z-val",
		"alpha": "a-val",
		"mango": "m-val",
	}
	got := appendContextFields(nil, ctx)
	if len(got) != 3 {
		t.Fatalf("expected 3 fields, got %d", len(got))
	}
	wantOrder := []string{"alpha", "mango", "zebra"}
	for i, want := range wantOrder {
		if got[i]["name"] != want {
			t.Errorf("field[%d].name = %v, want %v", i, got[i]["name"], want)
		}
		if inline, ok := got[i]["inline"].(bool); !ok || !inline {
			t.Errorf("field[%d].inline = %v, want true", i, got[i]["inline"])
		}
	}
}

func TestAppendContextFieldsValueFormatting(t *testing.T) {
	ctx := map[string]any{
		"any_slice":    []any{"a", 1, true},
		"string_slice": []string{"x", "y"},
		"plain":        42,
		"empty_str":    "",
	}
	got := appendContextFields(nil, ctx)
	// "empty_str" produces empty value and should be skipped.
	byName := map[string]string{}
	for _, f := range got {
		byName[f["name"].(string)] = f["value"].(string)
	}
	if _, ok := byName["empty_str"]; ok {
		t.Errorf("empty value should be skipped, got %v", byName["empty_str"])
	}
	if byName["any_slice"] != "a, 1, true" {
		t.Errorf("any_slice formatting = %q, want %q", byName["any_slice"], "a, 1, true")
	}
	if byName["string_slice"] != "x, y" {
		t.Errorf("string_slice formatting = %q", byName["string_slice"])
	}
	if byName["plain"] != "42" {
		t.Errorf("plain formatting = %q, want 42", byName["plain"])
	}
}

func TestFormatMs(t *testing.T) {
	tests := []struct {
		in   float64
		want string
	}{
		{0, "0 ms"},
		{0.001, "0 ms"},
		{12.345, "12.3 ms"},
		{999.9, "999.9 ms"},
		{1000, "1.0 s"},
		{2500, "2.5 s"},
	}
	for _, tt := range tests {
		if got := formatMs(tt.in); got != tt.want {
			t.Errorf("formatMs(%v) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestNotifierFireOnError(t *testing.T) {
	var (
		mu       sync.Mutex
		received []byte
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		buf := make([]byte, 8192)
		n, _ := r.Body.Read(buf)
		mu.Lock()
		received = append([]byte{}, buf[:n]...)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	ctx := map[string]any{"env": "test"}
	n := NewNotifier(server.URL, 2*time.Second, "default", ctx, 0, 0)
	n.FireOnError(OnErrorPayload{
		QName:        "example.com",
		ClientIP:     "10.0.0.1",
		Outcome:      "upstream_error",
		ErrorMessage: "boom",
	})

	// Wait briefly for async POST.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		ready := len(received) > 0
		mu.Unlock()
		if ready {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	body := received
	mu.Unlock()
	if len(body) == 0 {
		t.Fatal("expected error webhook to receive payload")
	}
	var payload OnErrorPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("payload not valid JSON: %v", err)
	}
	if payload.Outcome != "upstream_error" {
		t.Errorf("Outcome = %q", payload.Outcome)
	}
	if payload.Timestamp == "" {
		t.Errorf("Timestamp should be set automatically")
	}
	if payload.Context == nil || payload.Context["env"] != "test" {
		t.Errorf("Context not merged: %+v", payload.Context)
	}
}

func TestNotifierFireOnErrorNilSafe(t *testing.T) {
	var n *Notifier
	// Must not panic on nil receiver.
	n.FireOnError(OnErrorPayload{QName: "x"})
	// Empty URL → no-op.
	n2 := NewNotifier("", 0, "default", nil, 0, 0)
	n2.FireOnError(OnErrorPayload{QName: "x"})
}

func TestNotifierFireOnErrorRateLimited(t *testing.T) {
	var count int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&count, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	// max 1 message per minute, burst 1.
	n := NewNotifier(server.URL, time.Second, "default", nil, 1, time.Minute)
	n.FireOnError(OnErrorPayload{QName: "a.example.com"})
	n.FireOnError(OnErrorPayload{QName: "b.example.com"})
	n.FireOnError(OnErrorPayload{QName: "c.example.com"})

	time.Sleep(200 * time.Millisecond)
	got := atomic.LoadInt32(&count)
	if got != 1 {
		t.Errorf("expected exactly 1 request through rate limit, got %d", got)
	}
}

func TestDiscordFormatErrorIncludesErrorField(t *testing.T) {
	f := discordFormatter{}
	out, err := f.FormatError(OnErrorPayload{
		QName:        "example.com",
		Outcome:      "upstream_error",
		ClientIP:     "1.2.3.4",
		QType:        "A",
		DurationMs:   1234,
		ErrorMessage: "kaboom",
		Context:      map[string]any{"region": "us-east"},
	})
	if err != nil {
		t.Fatalf("FormatError: %v", err)
	}
	if !strings.Contains(string(out), "kaboom") {
		t.Errorf("expected error message included in Discord embed: %s", string(out))
	}
	if !strings.Contains(string(out), "region") {
		t.Errorf("expected context field included: %s", string(out))
	}
}
