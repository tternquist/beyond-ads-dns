# Webhooks

Beyond Ads DNS can send HTTP POST requests to configurable URLs when certain events occur. This enables integration with notification services (Slack, Discord, PagerDuty), automation platforms (Home Assistant, n8n), or custom monitoring systems.

## Configuration

Webhooks are configured in your YAML config under the `webhooks` section. Each webhook type (`on_block`, `on_error`) supports **multiple targets**, so you can send the same event to Discord, Slack, a custom endpoint, and more.

### Single target (legacy)

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

### Multiple targets

```yaml
webhooks:
  on_block:
    enabled: true
    rate_limit_per_minute: 60
    targets:
      - url: "https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN"
        target: "discord"
        context:
          tags: ["alerts"]
      - url: "https://your-server.com/webhook/block"
        target: "default"
        context:
          environment: "prod"
  on_error:
    enabled: true
    targets:
      - url: "https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN"
        target: "discord"
      - url: "https://hooks.slack.com/services/YOUR/WEBHOOK"
        target: "default"
```

| Field | Description |
|-------|-------------|
| `enabled` | Set to `true` to enable the webhook |
| `targets` | List of target destinations. Each target has `url`, `target`, and optional `context`. |
| `url` | (Legacy) Single URL when `targets` is not used |
| `timeout` | HTTP request timeout (e.g. `"5s"`, `"10s"`). Default: 5s |
| `rate_limit_per_minute` | Max webhooks per minute. Default: 60. Set to `-1` for unlimited. Can be overridden per target. |
| `target` | Target service to format the payload for. Omit or `"default"` for raw JSON. See [Supported targets](#supported-targets). |
| `context` | Optional key-value map merged into every payload (e.g. `tags`, `environment`). Use to add metadata without creating new hooks. |

### Supported targets

Specify `target` to have the payload formatted for the destination service. Unknown targets fall back to `default`.

| Target | Description |
|--------|-------------|
| `default` | Raw JSON (Beyond Ads native format). Use for custom endpoints, relays, or generic webhooks. |
| `discord` | Discord webhook format (embeds). Use your Discord webhook URL directly. |
| *future* | `slack`, `pagerduty`, etc. can be added. |

---

## on_block: Blocked Query Events

Fires when a DNS query is blocked by the blocklist (ads, trackers, malware).

### Payload

```json
{
  "qname": "ads.example.com",
  "client_ip": "192.168.1.100",
  "timestamp": "2025-02-15T14:30:00Z",
  "outcome": "blocked",
  "context": {
    "tags": ["production", "dns"],
    "environment": "prod"
  }
}
```

The `context` object is optional and only present when configured (see [Configuration](#configuration)).

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
| `context` | Optional. Custom key-values from webhook config (e.g. tags, environment). |

### Example: Adding tags and context

Add metadata to webhook payloads without creating new hooks:

```yaml
webhooks:
  on_block:
    enabled: true
    url: "https://your-server.com/webhook/block"
    context:
      tags: ["production", "dns"]
      environment: "prod"
  on_error:
    enabled: true
    url: "https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN"
    target: "discord"
    context:
      tags: ["alerts"]
      region: "us-east-1"
```

With `target: "default"`, the payload includes a `context` object. With `target: "discord"`, context appears as additional embed fields.

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

### Example: Discord (built-in)

Beyond Ads has built-in Discord support. Set `target: "discord"` and use your Discord webhook URL directly—no relay needed.

#### 1. Create a Discord webhook

1. Open your Discord server → **Server Settings** → **Integrations** → **Webhooks**
2. Click **New Webhook**, name it (e.g. "DNS Alerts"), choose the channel
3. Copy the **Webhook URL** (e.g. `https://discord.com/api/webhooks/123456789/abcdef...`)

#### 2. Configure Beyond Ads

```yaml
webhooks:
  on_block:
    enabled: true
    url: "https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN"
    target: "discord"
  on_error:
    enabled: true
    url: "https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN"
    target: "discord"
```

Block events show a green embed; error events show colored embeds (red for upstream_error, orange for servfail, etc.).

#### 3. Relay (optional)

If you need custom formatting or to combine with other services, use a relay:

**Option A: Python relay** — Receives Beyond Ads payload, transforms to Discord format, POSTs to Discord:

```python
from flask import Flask, request
import requests
import os

app = Flask(__name__)
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL")  # Your Discord webhook URL

# Discord embed colors: red=15158332, orange=15105570, yellow=16776960
OUTCOME_COLORS = {"upstream_error": 15158332, "servfail": 15105570, "servfail_backoff": 16776960, "invalid": 10038562}

@app.route("/discord-relay", methods=["POST"])
def relay():
    data = request.json or {}
    outcome = data.get("outcome", "unknown")
    color = OUTCOME_COLORS.get(outcome, 10038562)

    embed = {
        "title": "DNS Error",
        "color": color,
        "fields": [
            {"name": "Query", "value": data.get("qname", "-"), "inline": True},
            {"name": "Outcome", "value": outcome, "inline": True},
            {"name": "Client", "value": data.get("client_ip", "-"), "inline": True},
            {"name": "QType", "value": data.get("qtype", "-"), "inline": True},
            {"name": "Duration", "value": f"{data.get('duration_ms', 0):.1f} ms", "inline": True},
            {"name": "Upstream", "value": data.get("upstream_address") or "-", "inline": True},
        ],
        "timestamp": data.get("timestamp"),
    }
    if data.get("error_message"):
        embed["fields"].append({"name": "Error", "value": data["error_message"], "inline": False})

    payload = {"content": None, "embeds": [embed]}
    r = requests.post(DISCORD_WEBHOOK_URL, json=payload, timeout=5)
    return "", r.status_code
```

Run with: `DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... python app.py`

**Option B: n8n** — Webhook trigger → Set node (transform) → HTTP Request to Discord:

1. Create a Webhook node, copy its URL, use that as `url` in your config
2. Add a **Set** node to build the Discord payload from `$json`
3. Add an **HTTP Request** node: POST to your Discord webhook URL, body = `{{ $json }}`

#### 4. Example Discord notification

When an error occurs, Discord will show an embed like:

| Query      | Outcome        | Client       |
|-----------|----------------|--------------|
| example.com | upstream_error | 192.168.1.100 |

| QType | Duration | Upstream   |
|-------|----------|------------|
| A     | 1250.5 ms | 1.1.1.1:53 |

**Error:** context deadline exceeded

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
- **Rate:** Webhooks are rate-limited by default (60/min). Set `rate_limit_per_minute: -1` for unlimited, or increase the limit if needed.
- **Security:** Use HTTPS for webhook URLs. For sensitive endpoints, add authentication (e.g. secret in URL, custom header) and validate in your receiver.

---

## Troubleshooting

1. **Webhook not firing:** Ensure `enabled: true` and `url` is set. Restart the DNS service after config changes.
2. **Timeout errors:** Increase `timeout` if your endpoint is slow.
3. **Receiving duplicate events:** Each error generates one webhook. Use `servfail_backoff` to reduce SERVFAIL spam from the same failing upstream.
