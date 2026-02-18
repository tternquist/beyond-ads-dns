# Evaluation: Getting Application Logs into Grafana

This document evaluates options for integrating beyond-ads-dns application logs with Grafana, given the current architecture.

## Current Log Architecture

The application produces three types of logs:

| Log Type | Source | Format | Destination |
|----------|--------|--------|--------------|
| **Application logs** (slog) | `internal/logging`, `internal/errorlog` | JSON or text | stdout + optional `logs/errors-*.log` |
| **Error buffer** | `internal/errorlog/buffer.go` | Parsed from slog | In-memory + disk (errors-YYYY-MM-DD.log) |
| **Request log** | `internal/requestlog` | JSON or text | Optional `logs/dns-requests-*.log` |

- **slog** supports `format: "json"` for structured, machine-readable output.
- **ErrorBuffer** forwards to stdout, buffers errors/warnings, and optionally persists to disk.
- **Request log** writes DNS query entries (client, qname, outcome, duration, etc.) to daily-rotated files.

The Grafana integration example already includes **Prometheus** (metrics) and **ClickHouse** (query analytics). Logs are not yet integrated.

---

## Option 1: Loki + Promtail (Recommended)

**Approach:** Add Loki and Promtail to the stack. Promtail scrapes container stdout and/or log files and ships to Loki. Grafana queries Loki for logs.

### Pros
- **Native Grafana integration** — Loki is Grafana’s log aggregation backend; Explore and dashboards work well.
- **Low app changes** — No code changes; Promtail reads Docker logs and/or mounted log files.
- **Structured logs** — With `logging.format: "json"`, Loki indexes labels (level, msg, err) for filtering.
- **Unified stack** — Same Grafana instance for metrics (Prometheus), analytics (ClickHouse), and logs (Loki).
- **Retention control** — Loki supports retention policies and compaction.

### Cons
- Extra services (Loki, Promtail) and storage.
- Slightly more complex deployment.

### Implementation sketch

1. **Docker Compose** — Add Loki and Promtail to `examples/grafana-integration/docker-compose.yml`.
2. **Promtail config** — Scrape:
   - Docker container logs (stdout) for the `app` service.
   - Optional: mounted `logs/` volume for `errors-*.log` and `dns-requests-*.log`.
3. **Grafana datasource** — Provision Loki as a datasource.
4. **Log format** — Set `logging.format: "json"` in config for structured labels.

### Example Promtail pipeline (JSON parsing)

```yaml
scrape_configs:
  - job_name: beyond-ads-dns
    docker_sd_configs:
      - filters:
          - name: name
            values: ["beyond-ads-dns"]
    pipeline_stages:
      - json:
          expressions:
            level: level
            msg: msg
            time: time
      - labels:
          level:
```

---

## Option 2: Loki Direct Push (Application-Level)

**Approach:** Add a Loki client in the Go app and push log lines directly to Loki’s HTTP API.

### Pros
- No Promtail; fewer moving parts.
- Guaranteed delivery from the app (if you handle retries).
- Can add custom labels (instance, environment) at push time.

### Cons
- **Code changes** — New dependency, wiring, and error handling.
- **Coupling** — App depends on Loki availability; need buffering/backpressure.
- **Duplication** — Logs still go to stdout for Docker; you’re maintaining two paths.
- **Operational** — Harder to add new log sources (e.g. Node.js metrics API) without more code.

### Verdict
Not recommended unless you have strict requirements (e.g. no sidecar, no file access). Option 1 is simpler operationally.

---

## Option 3: ClickHouse as Log Backend

**Approach:** Store application logs in ClickHouse (already in the stack) and query via the Grafana ClickHouse datasource.

### Pros
- **No new services** — Reuse existing ClickHouse.
- **Powerful queries** — SQL, aggregations, joins with `dns_queries`.
- **Unified analytics** — Correlate logs with query data in one place.

### Cons
- **App changes** — Need a log sink that writes to ClickHouse (similar to querystore).
- **Schema design** — Table for logs (timestamp, level, msg, attributes, etc.).
- **Volume** — Application logs can be high volume; need batching, retention, and possibly sampling.
- **Grafana UX** — ClickHouse is better for metrics/analytics than for log browsing; Explore log UI is less polished than Loki.

### Implementation sketch

1. Add `internal/logsink/clickhouse.go` — Buffer and batch log entries.
2. Create ClickHouse table, e.g. `beyond_ads.application_logs`.
3. Wire a `io.Writer` or custom slog handler that forwards to the sink.
4. Add Grafana panels/dashboards with ClickHouse queries.

### Verdict
Reasonable if you want logs and query analytics in one DB and are comfortable with SQL. For pure log viewing and correlation with metrics, Loki is usually better.

---

## Option 4: Elasticsearch / OpenSearch

**Approach:** Ship logs to Elasticsearch/OpenSearch and use the Grafana Elasticsearch datasource.

### Pros
- Mature log stack; full-text search, Kibana-style features in Grafana.

### Cons
- **New service** — Elasticsearch is heavy and not in the current stack.
- **Complexity** — More components to run and maintain.
- **Overkill** — For a single-app deployment, Loki is lighter and sufficient.

### Verdict
Only consider if you already use Elasticsearch or need its search/analytics features.

---

## Option 5: Grafana Alloy (formerly Grafana Agent)

**Approach:** Use Grafana Alloy as a single agent that scrapes logs (and metrics) and forwards to Loki (and Prometheus).

### Pros
- Single agent for logs and metrics.
- Modern replacement for Promtail + Prometheus agent in some setups.
- Can scrape files, Docker, and other sources.

### Cons
- Newer; Promtail is still the standard for log collection.
- Slightly different config model.

### Verdict
Viable alternative to Promtail if you prefer a unified agent. Functionally similar to Option 1.

---

## Recommendation Summary

| Priority | Option | Effort | Best for |
|----------|--------|--------|----------|
| **1** | Loki + Promtail | Low | Standard setup, minimal app changes |
| 2 | ClickHouse logs | Medium | Reuse ClickHouse, SQL analytics |
| 3 | Loki direct push | Medium | No sidecar, app-controlled delivery |
| 4 | Grafana Alloy | Low | Unified agent |
| 5 | Elasticsearch | High | Existing ES/OpenSearch users |

**Recommended path: Option 1 (Loki + Promtail)**

1. Add Loki and Promtail to `examples/grafana-integration/docker-compose.yml`.
2. Configure Promtail to scrape the `app` container logs (and optionally `logs/` files).
3. Provision Loki as a Grafana datasource.
4. Set `logging.format: "json"` for structured log parsing.
5. Create a simple “Application Logs” dashboard or use Explore for ad-hoc log queries.

---

## Using External Loki

If you already run Loki elsewhere (e.g. Grafana Cloud, self-hosted Loki cluster, or another stack), you can send beyond-ads-dns logs to it without running Loki in this example.

### Option A: Promtail → External Loki

Run Promtail on the host where beyond-ads-dns runs (or where it can access the Docker socket). Point Promtail at your external Loki URL.

1. **Do not start** the Loki service from this example (or remove it from your compose).
2. **Configure Promtail** to push to your Loki:

   ```yaml
   # config/promtail.yml - change clients section
   clients:
     - url: https://your-loki-host:3100/loki/api/v1/push
       # If using Grafana Cloud:
       # - url: https://logs-prod-XXX.grafana.net/loki/api/v1/push
       #   tenant_id: YOUR_TENANT_ID  # or omit for single-tenant
       #   basic_auth:
       #     username: YOUR_USER
       #     password: YOUR_API_KEY
   ```

3. **Run Promtail** with the same scrape config (Docker discovery, pipeline stages) as in `examples/grafana-integration/config/promtail.yml`. Mount `/var/run/docker.sock` so Promtail can discover the `beyond-ads-dns` container.
4. **Add Loki as a datasource** in your Grafana instance (if not already) and use `{job="beyond-ads-dns"}` to query.

### Option B: Docker Loki Log Driver

Use the [Docker Loki log driver plugin](https://grafana.com/docs/loki/latest/send-data/docker-driver/) so Docker sends container stdout directly to Loki. No Promtail needed.

1. **Install the plugin** on the host:
   ```bash
   docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions
   ```

2. **Configure the app service** in your compose to use the Loki driver:
   ```yaml
   services:
     app:
       image: ghcr.io/tternquist/beyond-ads-dns:latest
       logging:
         driver: loki
         options:
           loki-url: "https://your-loki-host:3100/loki/api/v1/push"
           loki-batch-size: "400"
           # Optional: add labels for filtering
           loki-external-labels: 'job=beyond-ads-dns,app=beyond-ads-dns'
           # For Grafana Cloud, use basic auth:
           # loki-url: "https://logs-prod-XXX.grafana.net/loki/api/v1/push"
           # loki-tenant-id: "YOUR_TENANT_ID"
           # loki-auth-username: "YOUR_USER"
           # loki-auth-password: "YOUR_API_KEY"
   ```

3. **Do not run** Promtail or Loki from this example for logs.
4. Query in Grafana with `{job="beyond-ads-dns"}` (or whatever labels you set).

### Option C: Central Promtail (no local Promtail)

If you run Promtail centrally (e.g. on a log server) and cannot run it on the beyond-ads-dns host:

- **Use Option B** (Docker Loki driver), or
- **Ship log files**: Enable request log and error persistence, mount the logs directory, and have your central Promtail scrape those files via a shared volume or file forwarder.

### Common Settings (All Options)

- **Application log format**: Set **Settings → Application Logging → Format** to **JSON** in the Metrics UI for structured labels (level, msg, err).
- **Grafana datasource**: Add your Loki URL in Grafana → Configuration → Data sources. The Application Logs dashboard JSON uses `uid: "loki"`; either provision a datasource with that UID or edit the dashboard to use your datasource.

---

## Config Changes for Best Results

To get the most from any log backend:

1. **Enable JSON logging** — In the Metrics UI: **Settings** → **Application Logging** → **Format** → **JSON**. Or in `config.yaml`:
   ```yaml
   logging:
     format: "json"
     level: "info"   # or "debug" for troubleshooting
   ```

2. **Enable error persistence** (if not already) so errors are on disk and in stdout — In the Metrics UI: **Settings** → **Control** → **Error persistence** → **Enabled**. Or in `config.yaml`:
   ```yaml
   control:
     errors:
       enabled: true
       retention_days: 7
       log_level: "warning"
   ```

3. **Optional: enable request log** for DNS request debugging — In the Metrics UI: **Settings** → **Request Log** → **Enabled**, **Format** → **JSON**.

---

## Next Steps

1. Implement Option 1: add Loki + Promtail to the Grafana integration example.
2. Document the new services and datasource in the example README.
3. Optionally add a pre-built “Application Logs” dashboard.
4. Consider adding log-level alerts (e.g. error rate) in Grafana.
