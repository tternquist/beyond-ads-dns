# Webhooks

Beyond Ads DNS can send HTTP POST requests to configurable URLs when certain events occur. This enables integration with notification services (Slack, Discord, PagerDuty), automation platforms (Home Assistant, n8n), or custom monitoring systems.

## Configuration

Webhooks are configured in your YAML config under the `webhooks` section:

```yaml
webhooks:
  on_block:
    enabled: true
    url: "https://your-server.com/webhook/block"
    timeout: "5s"
  on_error:
    enabled: true
    url: "https://your-server.com/webhook/error"
    timeout: "5s"
```

| Field | Description |
|-------|-------------|
| `enabled` | Set to `true` to enable the webhook |
| `url` | Full URL to POST to (required when enabled) |
| `timeout` | HTTP request timeout (e.g. `"5s"`, `"10s"`). Default: 5s |

---

## on_block: Blocked Query Events

Fires when a DNS query is blocked by the blocklist (ads, trackers, malware).

### Payload

```json
{
  "qname": "ads.example.com",
  "client_ip": "192.168.1.100",
  "timestamp": "2025-02-15T14:30:00Z",
  "outcome": "blocked"
}
```

### Example: Home Assistant

```yaml
webhooks:
  on_block:
    enabled: true
    url: "http://homeassistant.local:8123/api/webhook/dns-blocked"
    timeout: "5s"
```

### Example: Generic Webhook Server (Node.js)

```javascript
// Express server receiving block webhooks
app.post('/webhook/block', express.json(), (req, res) => {
  const { qname, client_ip, timestamp, outcome } = req.body;
  console.log(`Blocked: ${qname} from ${client_ip} at ${timestamp}`);
  res.status(200).send('OK');
});
```

---

## on_error: DNS Error Events

Fires when a DNS query results in an error outcome. Use this to alert on upstream failures, SERVFAIL responses, or invalid queries.

### Error Outcomes

| Outcome | Description |
|---------|-------------|
| `upstream_error` | All upstream servers failed (timeout, connection refused, etc.) |
| `servfail` | Upstream returned SERVFAIL (upstream server error) |
| `servfail_backoff` | Returning cached SERVFAIL due to recent upstream failure |
| `invalid` | Malformed or empty query (e.g. no question in request) |

### Payload

```json
{
  "qname": "example.com",
  "client_ip": "192.168.1.100",
  "timestamp": "2025-02-15T14:30:00Z",
  "outcome": "upstream_error",
  "upstream_address": "1.1.1.1:53",
  "qtype": "A",
  "duration_ms": 1250.5,
  "error_message": "context deadline exceeded"
}
```

| Field | Description |
|-------|-------------|
| `qname` | Query name (or `"-"` for invalid queries) |
| `client_ip` | Client IP that made the request |
| `timestamp` | ISO 8601 UTC timestamp |
| `outcome` | Error type (see table above) |
| `upstream_address` | Upstream that failed (empty for `invalid`, may be empty for `upstream_error` if all failed) |
| `qtype` | DNS record type (A, AAAA, etc.) |
| `duration_ms` | Request duration in milliseconds |
| `error_message` | For `upstream_error`: the failure reason (e.g. timeout, connection refused) |

### Example: Slack

Use Slack's Incoming Webhooks. Create a webhook URL in Slack, then use a relay service or custom endpoint that forwards to Slack's API:

```yaml
webhooks:
  on_error:
    enabled: true
    url: "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
    timeout: "5s"
```

**Note:** Slack expects a specific JSON format. Use a middleware (e.g. n8n, Zapier, or a small proxy) to transform the payload:

```json
{
  "text": "DNS Error: upstream_error for example.com from 192.168.1.100",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*DNS Error*\n• Query: `example.com`\n• Outcome: `upstream_error`\n• Client: 192.168.1.100\n• Error: context deadline exceeded"
      }
    }
  ]
}
```

### Example: Discord

Discord webhooks expect a different format. Use a relay or n8n to transform:

```yaml
webhooks:
  on_error:
    enabled: true
    url: "https://discord.com/api/webhooks/YOUR/WEBHOOK"
    timeout: "5s"
```

Relay transformation to Discord format:

```json
{
  "content": null,
  "embeds": [
    {
      "title": "DNS Error",
      "color": 15158332,
      "fields": [
        { "name": "Query", "value": "example.com", "inline": true },
        { "name": "Outcome", "value": "upstream_error", "inline": true },
        { "name": "Client", "value": "192.168.1.100", "inline": true },
        { "name": "Error", "value": "context deadline exceeded", "inline": false }
      ],
      "timestamp": "2025-02-15T14:30:00Z"
    }
  ]
}
```

### Example: n8n Webhook Node

1. Create an n8n workflow with a Webhook trigger (POST).
2. Use the webhook URL as your config `url`.
3. Add nodes to filter, transform, or forward (Slack, email, etc.):

```yaml
webhooks:
  on_error:
    enabled: true
    url: "https://your-n8n.com/webhook/dns-errors"
    timeout: "5s"
```

### Example: Simple Logging Proxy (Python)

Forward webhooks to stdout or a file, and optionally to another service:

```python
from flask import Flask, request
import json

app = Flask(__name__)

@app.route('/webhook/error', methods=['POST'])
def error_webhook():
    data = request.json
    print(json.dumps(data, indent=2))
    # Optional: forward to Slack, PagerDuty, etc.
    return '', 200
```

### Example: PagerDuty

PagerDuty uses the Events API v2. Use a relay to convert:

```yaml
webhooks:
  on_error:
    enabled: true
    url: "https://your-relay.com/pagerduty"
    timeout: "5s"
```

Relay sends to `https://events.pagerduty.com/v2/enqueue`:

```json
{
  "routing_key": "YOUR_INTEGRATION_KEY",
  "event_action": "trigger",
  "payload": {
    "summary": "DNS upstream_error: example.com",
    "severity": "error",
    "source": "beyond-ads-dns",
    "custom_details": {
      "qname": "example.com",
      "outcome": "upstream_error",
      "client_ip": "192.168.1.100",
      "error_message": "context deadline exceeded"
    }
  }
}
```

---

## Behavior

- **Non-blocking:** Webhooks are fired asynchronously and do not delay DNS responses.
- **Fire-and-forget:** The resolver does not retry on HTTP failure. Ensure your endpoint is reliable.
- **Rate:** At high error rates, many webhooks may be sent. Consider rate limiting or batching in your receiver.
- **Security:** Use HTTPS for webhook URLs. For sensitive endpoints, add authentication (e.g. secret in URL, custom header) and validate in your receiver.

---

## Troubleshooting

1. **Webhook not firing:** Ensure `enabled: true` and `url` is set. Restart the DNS service after config changes.
2. **Timeout errors:** Increase `timeout` if your endpoint is slow.
3. **Receiving duplicate events:** Each error generates one webhook. Use `servfail_backoff` to reduce SERVFAIL spam from the same failing upstream.
