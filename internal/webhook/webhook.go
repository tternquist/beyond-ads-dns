package webhook

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"golang.org/x/time/rate"
)

// OnBlockPayload is sent when a query is blocked.
type OnBlockPayload struct {
	QName     string         `json:"qname"`
	ClientIP  string         `json:"client_ip"`
	Timestamp string         `json:"timestamp"`
	Outcome   string         `json:"outcome"`
	Context   map[string]any `json:"context,omitempty"` // optional: tags, env, etc. from webhook config
}

// OnErrorPayload is sent when a DNS query results in an error outcome.
type OnErrorPayload struct {
	QName           string         `json:"qname"`
	ClientIP        string         `json:"client_ip"`
	Timestamp       string         `json:"timestamp"`
	Outcome         string         `json:"outcome"`          // upstream_error, servfail, servfail_backoff, invalid
	UpstreamAddress string         `json:"upstream_address"` // empty for invalid/upstream_error when unknown
	QType           string         `json:"qtype"`
	DurationMs      float64        `json:"duration_ms"`
	ErrorMessage    string         `json:"error_message,omitempty"` // for upstream_error: exchange failure reason
	Context         map[string]any `json:"context,omitempty"`        // optional: tags, env, etc. from webhook config
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
	context  map[string]any // optional: tags, env, etc. merged into every payload
	limiter  *rate.Limiter // nil when rate limiting disabled (rateLimitPerMinute <= 0)
}

// NewNotifier creates a webhook notifier. url must be non-empty.
// target: service to format for ("default"=raw JSON, "discord", "slack", etc.). Unknown targets use default.
// context: optional map merged into every payload (e.g. tags, environment).
// rateLimitPerMinute: max webhooks per minute; 0 or negative = unlimited.
func NewNotifier(url string, timeout time.Duration, target string, context map[string]any, rateLimitPerMinute int) *Notifier {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	t := strings.TrimSpace(strings.ToLower(target))
	f, ok := formatterRegistry[t]
	if !ok {
		f = formatterRegistry["default"]
	}
	n := &Notifier{
		url:       url,
		timeout:   timeout,
		client:    &http.Client{Timeout: timeout},
		formatter: f,
		context:   context,
	}
	if rateLimitPerMinute > 0 {
		// Token bucket: refill at rateLimitPerMinute/60 per second, burst = min(limit/6, 20)
		burst := rateLimitPerMinute / 6
		if burst < 1 {
			burst = 1
		}
		if burst > 20 {
			burst = 20
		}
		n.limiter = rate.NewLimiter(rate.Limit(rateLimitPerMinute)/60.0, burst)
	}
	return n
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
	fields := []map[string]any{
		{"name": "Query", "value": p.QName, "inline": true},
		{"name": "Client", "value": p.ClientIP, "inline": true},
		{"name": "Outcome", "value": p.Outcome, "inline": true},
	}
	fields = appendContextFields(fields, p.Context)
	embed := map[string]any{
		"title":     "Blocked Query",
		"color":     3066993, // green
		"fields":    fields,
		"timestamp": p.Timestamp,
	}
	return json.Marshal(map[string]any{"content": nil, "embeds": []map[string]any{embed}})
}

func (discordFormatter) FormatError(p OnErrorPayload) ([]byte, error) {
	colors := map[string]int{
		"upstream_error":     15158332, // red
		"servfail":           15105570, // orange
		"servfail_backoff":   16776960, // yellow
		"invalid":            10038562, // gray
		"application_error":  15158332, // red
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
	fields = appendContextFields(fields, p.Context)
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

// appendContextFields adds context key-values as Discord embed fields. Skips empty context.
func appendContextFields(fields []map[string]any, ctx map[string]any) []map[string]any {
	if len(ctx) == 0 {
		return fields
	}
	// Sort keys for deterministic output
	keys := make([]string, 0, len(ctx))
	for k := range ctx {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		v := ctx[k]
		var val string
		switch t := v.(type) {
		case []any:
			parts := make([]string, len(t))
			for i, x := range t {
				parts[i] = fmt.Sprintf("%v", x)
			}
			val = strings.Join(parts, ", ")
		case []string:
			val = strings.Join(t, ", ")
		default:
			val = fmt.Sprintf("%v", v)
		}
		if val != "" {
			fields = append(fields, map[string]any{"name": k, "value": val, "inline": true})
		}
	}
	return fields
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
// Drops the webhook if rate limit is exceeded.
func (n *Notifier) FireOnBlock(qname, clientIP string) {
	if n == nil || n.url == "" {
		return
	}
	if n.limiter != nil && !n.limiter.Allow() {
		return
	}
	payload := OnBlockPayload{
		QName:     qname,
		ClientIP:  clientIP,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Outcome:   "blocked",
		Context:   n.context,
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
// Drops the webhook if rate limit is exceeded.
func (n *Notifier) FireOnError(payload OnErrorPayload) {
	if n == nil || n.url == "" {
		return
	}
	if n.limiter != nil && !n.limiter.Allow() {
		return
	}
	if payload.Timestamp == "" {
		payload.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}
	payload.Context = n.context
	body, err := n.formatter.FormatError(payload)
	if err != nil {
		return
	}
	go n.post(body)
}
