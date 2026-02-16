package requestlog

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestNewWriter(t *testing.T) {
	buf := &bytes.Buffer{}
	w := NewWriter(buf, "text")
	if w == nil {
		t.Fatal("NewWriter(text) returned nil")
	}
	w.Write(Entry{})
	if buf.Len() == 0 {
		t.Error("text writer did not write")
	}

	buf.Reset()
	w = NewWriter(buf, "json")
	if w == nil {
		t.Fatal("NewWriter(json) returned nil")
	}
	w.Write(Entry{})
	if buf.Len() == 0 {
		t.Error("json writer did not write")
	}

	// Unknown format defaults to text
	buf.Reset()
	w = NewWriter(buf, "unknown")
	w.Write(Entry{Timestamp: "2024-01-01T00:00:00Z"})
	if buf.Len() == 0 {
		t.Error("unknown format writer did not write")
	}
}

func TestTextWriter(t *testing.T) {
	buf := &bytes.Buffer{}
	w := NewWriter(buf, "text")
	if w == nil {
		t.Fatal("expected textWriter")
	}

	entry := Entry{
		Timestamp:      "2024-01-15T12:00:00.000Z",
		ClientIP:       "192.168.1.1",
		Protocol:       "udp",
		QName:          "example.com.",
		QType:          "A",
		QClass:         "IN",
		Outcome:        "resolved",
		RCode:          "NOERROR",
		DurationMS:     1.5,
		UpstreamAddress: "8.8.8.8:53",
	}
	w.Write(entry)
	line := buf.String()
	if !strings.Contains(line, "2024-01-15T12:00:00.000Z") {
		t.Errorf("expected timestamp in output, got %q", line)
	}
	if !strings.Contains(line, "example.com") {
		t.Errorf("expected qname in output, got %q", line)
	}
	if !strings.Contains(line, "duration_ms=1.50") {
		t.Errorf("expected duration_ms=1.50 (2 decimal), got %q", line)
	}
}

func TestTextWriterWithCacheAndNetworkMetrics(t *testing.T) {
	buf := &bytes.Buffer{}
	w := NewWriter(buf, "text")

	entry := Entry{
		Timestamp:        "2024-01-15T12:00:00.000Z",
		ClientIP:         "10.0.0.1",
		Protocol:         "tcp",
		QName:            "test.example.com.",
		QType:            "AAAA",
		QClass:           "IN",
		Outcome:          "resolved",
		RCode:            "NOERROR",
		DurationMS:       5.123,
		CacheLookupMS:    0.5,
		NetworkWriteMS:    2.0,
		UpstreamAddress:   "1.1.1.1:53",
	}
	w.Write(entry)
	line := buf.String()
	if !strings.Contains(line, "cache_lookup_ms=0.500") {
		t.Errorf("expected cache_lookup_ms in output, got %q", line)
	}
	if !strings.Contains(line, "network_write_ms=2.000") {
		t.Errorf("expected network_write_ms in output, got %q", line)
	}
	if !strings.Contains(line, "duration_ms=5.123") {
		t.Errorf("expected duration_ms=5.123 (3 decimal), got %q", line)
	}
}

func TestJsonWriter(t *testing.T) {
	buf := &bytes.Buffer{}
	w := NewWriter(buf, "json")
	if w == nil {
		t.Fatal("expected jsonWriter")
	}

	entry := Entry{
		Timestamp:       "2024-01-15T12:00:00.000Z",
		ClientIP:        "192.168.1.100",
		Protocol:        "udp",
		QName:           "example.org.",
		QType:           "A",
		QClass:          "IN",
		Outcome:         "blocked",
		RCode:           "NXDOMAIN",
		DurationMS:      0.1,
		UpstreamAddress: "",
	}
	w.Write(entry)
	line := strings.TrimSpace(buf.String())
	var decoded Entry
	if err := json.Unmarshal([]byte(line), &decoded); err != nil {
		t.Fatalf("json output not valid: %v\noutput: %q", err, line)
	}
	if decoded.QName != entry.QName {
		t.Errorf("decoded QName = %q, want %q", decoded.QName, entry.QName)
	}
	if decoded.Outcome != entry.Outcome {
		t.Errorf("decoded Outcome = %q, want %q", decoded.Outcome, entry.Outcome)
	}
	if decoded.DurationMS != entry.DurationMS {
		t.Errorf("decoded DurationMS = %v, want %v", decoded.DurationMS, entry.DurationMS)
	}
}

func TestJsonWriterWithQueryID(t *testing.T) {
	buf := &bytes.Buffer{}
	w := NewWriter(buf, "json")

	entry := Entry{
		QueryID:   "abc-123",
		Timestamp: "2024-01-15T12:00:00.000Z",
		ClientIP:  "10.0.0.1",
		Protocol:  "udp",
		QName:     "test.com.",
		QType:     "A",
		QClass:    "IN",
		Outcome:   "resolved",
		RCode:     "NOERROR",
		DurationMS: 1.0,
	}
	w.Write(entry)
	line := strings.TrimSpace(buf.String())
	var decoded map[string]any
	if err := json.Unmarshal([]byte(line), &decoded); err != nil {
		t.Fatalf("json output not valid: %v", err)
	}
	if decoded["query_id"] != "abc-123" {
		t.Errorf("expected query_id in output, got %v", decoded["query_id"])
	}
}

func TestFormatTimestamp(t *testing.T) {
	ts := time.Date(2024, 1, 15, 12, 30, 45, 123000000, time.UTC)
	got := FormatTimestamp(ts)
	if got != "2024-01-15T12:30:45.123Z" {
		t.Errorf("FormatTimestamp = %q, want 2024-01-15T12:30:45.123Z", got)
	}
}
