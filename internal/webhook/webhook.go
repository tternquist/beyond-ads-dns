package webhook

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// OnBlockPayload is sent when a query is blocked.
type OnBlockPayload struct {
	QName     string `json:"qname"`
	ClientIP  string `json:"client_ip"`
	Timestamp string `json:"timestamp"`
	Outcome   string `json:"outcome"`
}

// OnErrorPayload is sent when a DNS query results in an error outcome.
type OnErrorPayload struct {
	QName           string  `json:"qname"`
	ClientIP        string  `json:"client_ip"`
	Timestamp       string  `json:"timestamp"`
	Outcome         string  `json:"outcome"`          // upstream_error, servfail, servfail_backoff, invalid
	UpstreamAddress string  `json:"upstream_address"` // empty for invalid/upstream_error when unknown
	QType           string  `json:"qtype"`
	DurationMs      float64 `json:"duration_ms"`
	ErrorMessage    string  `json:"error_message,omitempty"` // for upstream_error: exchange failure reason
}

// Notifier fires webhooks on block and error events.
type Notifier struct {
	url     string
	timeout time.Duration
	client  *http.Client
	format  string // "default" or "discord"
}

// NewNotifier creates a webhook notifier. url must be non-empty.
// format: "default" sends raw JSON; "discord" sends Discord embed format.
func NewNotifier(url string, timeout time.Duration, format string) *Notifier {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	f := strings.TrimSpace(strings.ToLower(format))
	if f != "discord" {
		f = "default"
	}
	return &Notifier{
		url:     url,
		timeout: timeout,
		client:  &http.Client{Timeout: timeout},
		format:  f,
	}
}

// FireOnBlock sends a POST request with the block payload. Non-blocking; runs in a goroutine.
func (n *Notifier) FireOnBlock(qname, clientIP string) {
	if n == nil || n.url == "" {
		return
	}
	payload := OnBlockPayload{
		QName:     qname,
		ClientIP:  clientIP,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Outcome:   "blocked",
	}
	var body []byte
	var err error
	if n.format == "discord" {
		body, err = json.Marshal(n.discordBlockPayload(payload))
	} else {
		body, err = json.Marshal(payload)
	}
	if err != nil {
		return
	}
	go n.post(body)
}

func (n *Notifier) post(body []byte) {
	req, err := http.NewRequest(http.MethodPost, n.url, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	_, _ = n.client.Do(req)
}

// discordBlockPayload builds a Discord webhook payload for block events.
func (n *Notifier) discordBlockPayload(p OnBlockPayload) map[string]any {
	return map[string]any{
		"content": nil,
		"embeds": []map[string]any{
			{
				"title":  "Blocked Query",
				"color":  3066993, // green
				"fields": []map[string]any{
					{"name": "Query", "value": p.QName, "inline": true},
					{"name": "Client", "value": p.ClientIP, "inline": true},
					{"name": "Outcome", "value": p.Outcome, "inline": true},
				},
				"timestamp": p.Timestamp,
			},
		},
	}
}

// discordErrorPayload builds a Discord webhook payload for error events.
func (n *Notifier) discordErrorPayload(p OnErrorPayload) map[string]any {
	colors := map[string]int{
		"upstream_error":    15158332, // red
		"servfail":          15105570, // orange
		"servfail_backoff":  16776960, // yellow
		"invalid":           10038562, // gray
	}
	color := 10038562
	if c, ok := colors[p.Outcome]; ok {
		color = c
	}
	upstream := p.UpstreamAddress
	if upstream == "" {
		upstream = "-"
	}
	fields := []map[string]any{
		{"name": "Query", "value": p.QName, "inline": true},
		{"name": "Outcome", "value": p.Outcome, "inline": true},
		{"name": "Client", "value": p.ClientIP, "inline": true},
		{"name": "QType", "value": p.QType, "inline": true},
		{"name": "Duration", "value": formatMs(p.DurationMs), "inline": true},
		{"name": "Upstream", "value": upstream, "inline": true},
	}
	if p.ErrorMessage != "" {
		fields = append(fields, map[string]any{"name": "Error", "value": p.ErrorMessage, "inline": false})
	}
	return map[string]any{
		"content": nil,
		"embeds": []map[string]any{
			{
				"title":     "DNS Error",
				"color":     color,
				"fields":    fields,
				"timestamp": p.Timestamp,
			},
		},
	}
}

func formatMs(ms float64) string {
	if ms < 0.01 {
		return "0 ms"
	}
	if ms >= 1000 {
		return fmt.Sprintf("%.1f s", ms/1000)
	}
	return fmt.Sprintf("%.1f ms", ms)
}

// FireOnError sends a POST request with the error payload. Non-blocking; runs in a goroutine.
func (n *Notifier) FireOnError(payload OnErrorPayload) {
	if n == nil || n.url == "" {
		return
	}
	if payload.Timestamp == "" {
		payload.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}
	var body []byte
	var err error
	if n.format == "discord" {
		body, err = json.Marshal(n.discordErrorPayload(payload))
	} else {
		body, err = json.Marshal(payload)
	}
	if err != nil {
		return
	}
	go n.post(body)
}
