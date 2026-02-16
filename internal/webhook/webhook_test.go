package webhook

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestSupportedTargets(t *testing.T) {
	targets := SupportedTargets()
	if len(targets) < 2 {
		t.Errorf("expected at least 2 targets (default, discord), got %d", len(targets))
	}
	seen := make(map[string]bool)
	for _, tgt := range targets {
		if seen[tgt] {
			t.Errorf("duplicate target %q", tgt)
		}
		seen[tgt] = true
	}
	if !seen["default"] {
		t.Error("expected default target")
	}
	if !seen["discord"] {
		t.Error("expected discord target")
	}
}

func TestDefaultFormatterFormatBlock(t *testing.T) {
	f := defaultFormatter{}
	payload := OnBlockPayload{
		QName:     "ads.example.com",
		ClientIP:  "192.168.1.1",
		Timestamp: "2024-01-15T12:00:00Z",
		Outcome:   "blocked",
	}
	data, err := f.FormatBlock(payload)
	if err != nil {
		t.Fatalf("FormatBlock: %v", err)
	}
	var decoded OnBlockPayload
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("FormatBlock output not valid JSON: %v", err)
	}
	if decoded.QName != payload.QName {
		t.Errorf("decoded QName = %q, want %q", decoded.QName, payload.QName)
	}
	if decoded.Outcome != payload.Outcome {
		t.Errorf("decoded Outcome = %q, want %q", decoded.Outcome, payload.Outcome)
	}
}

func TestDefaultFormatterFormatError(t *testing.T) {
	f := defaultFormatter{}
	payload := OnErrorPayload{
		QName:           "example.com",
		ClientIP:        "10.0.0.1",
		Timestamp:       "2024-01-15T12:00:00Z",
		Outcome:         "upstream_error",
		UpstreamAddress: "8.8.8.8:53",
		QType:           "A",
		DurationMs:      50.5,
		ErrorMessage:    "connection refused",
	}
	data, err := f.FormatError(payload)
	if err != nil {
		t.Fatalf("FormatError: %v", err)
	}
	var decoded OnErrorPayload
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("FormatError output not valid JSON: %v", err)
	}
	if decoded.Outcome != payload.Outcome {
		t.Errorf("decoded Outcome = %q, want %q", decoded.Outcome, payload.Outcome)
	}
	if decoded.ErrorMessage != payload.ErrorMessage {
		t.Errorf("decoded ErrorMessage = %q, want %q", decoded.ErrorMessage, payload.ErrorMessage)
	}
}

func TestDiscordFormatterFormatBlock(t *testing.T) {
	f := discordFormatter{}
	payload := OnBlockPayload{
		QName:     "ads.example.com",
		ClientIP:  "192.168.1.1",
		Timestamp: "2024-01-15T12:00:00Z",
		Outcome:   "blocked",
	}
	data, err := f.FormatBlock(payload)
	if err != nil {
		t.Fatalf("FormatBlock: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("FormatBlock output not valid JSON: %v", err)
	}
	embeds, ok := decoded["embeds"].([]any)
	if !ok || len(embeds) == 0 {
		t.Fatal("expected embeds array")
	}
	embed := embeds[0].(map[string]any)
	if embed["title"] != "Blocked Query" {
		t.Errorf("embed title = %v, want Blocked Query", embed["title"])
	}
}

func TestDiscordFormatterFormatError(t *testing.T) {
	f := discordFormatter{}
	payload := OnErrorPayload{
		QName:           "example.com",
		ClientIP:        "10.0.0.1",
		Outcome:         "upstream_error",
		UpstreamAddress:  "8.8.8.8:53",
		QType:           "A",
		DurationMs:      100,
		ErrorMessage:    "timeout",
	}
	data, err := f.FormatError(payload)
	if err != nil {
		t.Fatalf("FormatError: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("FormatError output not valid JSON: %v", err)
	}
	embeds, ok := decoded["embeds"].([]any)
	if !ok || len(embeds) == 0 {
		t.Fatal("expected embeds array")
	}
	embed := embeds[0].(map[string]any)
	if embed["title"] != "DNS Error" {
		t.Errorf("embed title = %v, want DNS Error", embed["title"])
	}
}

func TestNotifierFireOnBlock(t *testing.T) {
	var received []byte
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		body := make([]byte, 4096)
		n, _ := r.Body.Read(body)
		mu.Lock()
		received = make([]byte, n)
		copy(received, body[:n])
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	n := NewNotifier(server.URL, 2*time.Second, "default", nil, 0, 0) // no rate limit
	n.FireOnBlock("ads.example.com", "192.168.1.1")

	// FireOnBlock is async; wait for request
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	got := received
	mu.Unlock()

	if len(got) == 0 {
		t.Fatal("expected webhook to receive payload")
	}
	var payload OnBlockPayload
	if err := json.Unmarshal(got, &payload); err != nil {
		t.Fatalf("received payload not valid JSON: %v", err)
	}
	if payload.QName != "ads.example.com" {
		t.Errorf("payload QName = %q, want ads.example.com", payload.QName)
	}
	if payload.ClientIP != "192.168.1.1" {
		t.Errorf("payload ClientIP = %q, want 192.168.1.1", payload.ClientIP)
	}
}

func TestNotifierFireOnBlockWithContext(t *testing.T) {
	var received []byte
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := make([]byte, 4096)
		n, _ := r.Body.Read(body)
		mu.Lock()
		received = make([]byte, n)
		copy(received, body[:n])
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	ctx := map[string]any{"environment": "test", "tags": []string{"dns"}}
	n := NewNotifier(server.URL, 2*time.Second, "default", ctx, 0, 0)
	n.FireOnBlock("blocked.example.com", "10.0.0.1")

	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	got := received
	mu.Unlock()

	if len(got) == 0 {
		t.Fatal("expected webhook to receive payload")
	}
	var payload OnBlockPayload
	if err := json.Unmarshal(got, &payload); err != nil {
		t.Fatalf("received payload not valid JSON: %v", err)
	}
	if payload.Context == nil {
		t.Fatal("expected context in payload")
	}
	if payload.Context["environment"] != "test" {
		t.Errorf("context environment = %v, want test", payload.Context["environment"])
	}
}

func TestNotifierNilNoOp(t *testing.T) {
	// FireOnBlock on nil notifier should not panic
	var n *Notifier
	n.FireOnBlock("example.com", "1.2.3.4")
}

func TestNotifierEmptyURLNoOp(t *testing.T) {
	n := NewNotifier("", 5*time.Second, "default", nil, 0, 0)
	n.FireOnBlock("example.com", "1.2.3.4")
	// Should not panic or make any request
}
