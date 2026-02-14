package webhook

import (
	"bytes"
	"encoding/json"
	"net/http"
	"time"
)

// OnBlockPayload is sent when a query is blocked.
type OnBlockPayload struct {
	QName     string `json:"qname"`
	ClientIP  string `json:"client_ip"`
	Timestamp string `json:"timestamp"`
	Outcome   string `json:"outcome"`
}

// Notifier fires webhooks on block events.
type Notifier struct {
	url     string
	timeout time.Duration
	client  *http.Client
}

// NewNotifier creates a webhook notifier. url must be non-empty.
func NewNotifier(url string, timeout time.Duration) *Notifier {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &Notifier{
		url:     url,
		timeout: timeout,
		client:  &http.Client{Timeout: timeout},
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
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	go func() {
		req, err := http.NewRequest(http.MethodPost, n.url, bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		_, _ = n.client.Do(req)
	}()
}
