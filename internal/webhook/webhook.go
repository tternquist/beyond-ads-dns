package webhook

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
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

// Formatter formats payloads for a specific target service (discord, slack, etc.).
type Formatter interface {
	FormatBlock(OnBlockPayload) ([]byte, error)
	FormatError(OnErrorPayload) ([]byte, error)
}

// formatterRegistry maps target names to formatters. Add new targets here.
var formatterRegistry = map[string]Formatter{
	"default": defaultFormatter{},
	"discord": discordFormatter{},
	// "slack": slackFormatter{},  // future
	// "pagerduty": pagerdutyFormatter{},  // future
}

// SupportedTargets returns the list of target names that have built-in formatters.
func SupportedTargets() []string {
	keys := make([]string, 0, len(formatterRegistry))
	for k := range formatterRegistry {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Notifier fires webhooks on block and error events.
type Notifier struct {
	url      string
	timeout  time.Duration
	client   *http.Client
	formatter Formatter
}

// NewNotifier creates a webhook notifier. url must be non-empty.
// target: service to format for ("default"=raw JSON, "discord", "slack", etc.). Unknown targets use default.
func NewNotifier(url string, timeout time.Duration, target string) *Notifier {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	t := strings.TrimSpace(strings.ToLower(target))
	f, ok := formatterRegistry[t]
	if !ok {
		f = formatterRegistry["default"]
	}
	return &Notifier{
		url:       url,
		timeout:   timeout,
		client:    &http.Client{Timeout: timeout},
		formatter: f,
	}
}

// defaultFormatter sends raw JSON (Beyond Ads native format).
type defaultFormatter struct{}

func (defaultFormatter) FormatBlock(p OnBlockPayload) ([]byte, error) {
	return json.Marshal(p)
}

func (defaultFormatter) FormatError(p OnErrorPayload) ([]byte, error) {
	return json.Marshal(p)
}

// discordFormatter formats payloads for Discord webhooks (embeds).
type discordFormatter struct{}

func (discordFormatter) FormatBlock(p OnBlockPayload) ([]byte, error) {
	payload := map[string]any{
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
	return json.Marshal(payload)
}

func (discordFormatter) FormatError(p OnErrorPayload) ([]byte, error) {
	colors := map[string]int{
		"upstream_error":   15158332, // red
		"servfail":         15105570, // orange
		"servfail_backoff": 16776960, // yellow
		"invalid":          10038562, // gray
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
	payload := map[string]any{
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
	return json.Marshal(payload)
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
	body, err := n.formatter.FormatBlock(payload)
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

// FireOnError sends a POST request with the error payload. Non-blocking; runs in a goroutine.
func (n *Notifier) FireOnError(payload OnErrorPayload) {
	if n == nil || n.url == "" {
		return
	}
	if payload.Timestamp == "" {
		payload.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}
	body, err := n.formatter.FormatError(payload)
	if err != nil {
		return
	}
	go n.post(body)
}
