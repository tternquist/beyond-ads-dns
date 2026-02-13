package requestlog

import (
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"time"
)

// Entry represents a single DNS request log entry.
type Entry struct {
	QueryID        string  `json:"query_id,omitempty"`
	Timestamp      string  `json:"timestamp"`
	ClientIP       string  `json:"client_ip"`
	Protocol       string  `json:"protocol"`
	QName          string  `json:"qname"`
	QType          string  `json:"qtype"`
	QClass         string  `json:"qclass"`
	Outcome        string  `json:"outcome"`
	RCode          string  `json:"rcode"`
	DurationMS      float64 `json:"duration_ms"`
	CacheLookupMS   float64 `json:"cache_lookup_ms,omitempty"`
	NetworkWriteMS  float64 `json:"network_write_ms,omitempty"`
	UpstreamAddress string `json:"upstream_address,omitempty"`
}

// Writer writes request log entries in text or JSON format.
type Writer interface {
	Write(entry Entry)
}

type textWriter struct {
	mu     sync.Mutex
	writer io.Writer
}

type jsonWriter struct {
	mu     sync.Mutex
	writer io.Writer
}

// NewWriter creates a Writer that formats entries as text or JSON.
// format must be "text" or "json".
func NewWriter(w io.Writer, format string) Writer {
	if format == "json" {
		return &jsonWriter{writer: w}
	}
	return &textWriter{writer: w}
}

func (t *textWriter) Write(entry Entry) {
	t.mu.Lock()
	defer t.mu.Unlock()
	var line string
	if entry.CacheLookupMS > 0 || entry.NetworkWriteMS > 0 {
		line = fmt.Sprintf("%s client=%s protocol=%s qname=%s qtype=%s qclass=%s outcome=%s rcode=%s duration_ms=%.3f cache_lookup_ms=%.3f network_write_ms=%.3f upstream=%s\n",
			entry.Timestamp, entry.ClientIP, entry.Protocol, entry.QName, entry.QType, entry.QClass,
			entry.Outcome, entry.RCode, entry.DurationMS, entry.CacheLookupMS, entry.NetworkWriteMS, entry.UpstreamAddress)
	} else {
		line = fmt.Sprintf("%s client=%s protocol=%s qname=%s qtype=%s qclass=%s outcome=%s rcode=%s duration_ms=%.2f upstream=%s\n",
			entry.Timestamp, entry.ClientIP, entry.Protocol, entry.QName, entry.QType, entry.QClass,
			entry.Outcome, entry.RCode, entry.DurationMS, entry.UpstreamAddress)
	}
	_, _ = t.writer.Write([]byte(line))
}

func (j *jsonWriter) Write(entry Entry) {
	j.mu.Lock()
	defer j.mu.Unlock()
	data, err := json.Marshal(entry)
	if err != nil {
		return
	}
	data = append(data, '\n')
	_, _ = j.writer.Write(data)
}

// FormatTimestamp returns a timestamp string for log entries.
func FormatTimestamp(t time.Time) string {
	return t.Format("2006-01-02T15:04:05.000Z07:00")
}
