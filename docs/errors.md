# Known Errors and Troubleshooting

This document describes errors that may appear in the Error Viewer and their possible causes.

## Error List

- [sync-config-applied](#sync-config-applied) · [sync-config-served](#sync-config-served) · [blocklist-bloom-filter](#blocklist-bloom-filter) · [blocklist-partial-load](#blocklist-partial-load) · [blocklist-source-empty](#blocklist-source-empty) · [sync-pull-error](#sync-pull-error) · [sync-blocklist-reload-error](#sync-blocklist-reload-error) · [sync-local-records-reload-error](#sync-local-records-reload-error) · [sync-stats-error](#sync-stats-error) · [sync-stats-source-fetch-error](#sync-stats-source-fetch-error) · [sync-token-update-error](#sync-token-update-error) · [upstream-exchange-failed](#upstream-exchange-failed) · [cache-get-failed](#cache-get-failed) · [cache-set-failed](#cache-set-failed) · [cache-hit-counter-failed](#cache-hit-counter-failed) · [sweep-hit-counter-failed](#sweep-hit-counter-failed) · [servfail-backoff-active](#servfail-backoff-active) · [refresh-upstream-failed](#refresh-upstream-failed) · [refresh-servfail-backoff](#refresh-servfail-backoff) · [refresh-cache-set-failed](#refresh-cache-set-failed) · [refresh-sweep](#refresh-sweep) · [refresh-sweep-failed](#refresh-sweep-failed) · [refresh-lock-failed](#refresh-lock-failed) · [l0-cache-cleanup](#l0-cache-cleanup) · [blocklist-load-failed](#blocklist-load-failed) · [blocklist-source-status](#blocklist-source-status) · [blocklist-health-check](#blocklist-health-check) · [blocklist-refresh-failed](#blocklist-refresh-failed) · [invalid-regex-pattern](#invalid-regex-pattern) · [local-record-error](#local-record-error) · [dot-server-error](#dot-server-error) · [doh-server-error](#doh-server-error) · [control-server-error](#control-server-error) · [write-response-failed](#write-response-failed) · [cache-key-cleanup-sweep-below-threshold](#cache-key-cleanup-sweep-below-threshold) · [query-store-buffer-full](#query-store-buffer-full) · [query-retention-set](#query-retention-set) · [clickhouse-insert-failed](#clickhouse-insert-failed)

---

## Log Levels

Set `logging.level` (Settings → Application Logging) to control which messages are buffered and shown:

- **error** — Only errors (webhook-triggering)
- **warning** — Errors and warnings (default)
- **info** — Errors, warnings, and informational messages
- **debug** — All of the above plus debug events (cache cleanup, sync events, refresh sweep details)

Use `debug` when troubleshooting cache behavior, sync flows, or refresh sweeper activity.

---

## Trace Events

Trace events emit debug-level logs for specific resolver operations. Enable them in the Error Viewer (or via the control API `/trace-events`) to get detailed per-query or per-refresh logs without restarting. Changes apply immediately.

| Trace event | Description | Useful when troubleshooting |
|-------------|-------------|------------------------------|
| **refresh_upstream** | Background refresh requests to upstream DNS | [refresh-upstream-failed](#refresh-upstream-failed), [refresh-servfail-backoff](#refresh-servfail-backoff), [refresh-cache-set-failed](#refresh-cache-set-failed), [refresh-sweep-failed](#refresh-sweep-failed) |
| **query_resolution** | Full query path: outcome (local, cached, stale, blocked, etc.) | [upstream-exchange-failed](#upstream-exchange-failed), [servfail-backoff-active](#servfail-backoff-active), cache-related errors, blocked/forwarded behavior |
| **upstream_exchange** | Client-initiated upstream queries: selected upstream, retries | [upstream-exchange-failed](#upstream-exchange-failed), upstream selection, timeout or backoff issues |

Combine trace events with `debug` log level to see the trace output in the Error Viewer.

---

## sync-config-applied

**What it is:** Debug/informational log. Sync successfully pulled configuration from the primary and applied it (blocklist, local records, upstream, etc.).

**Why it happens:** Normal sync operation. No action needed.

---

## sync-config-served

**What it is:** Debug/informational log. The primary successfully served configuration to a replica during a sync request.

**Why it happens:** Normal sync operation. No action needed.

---

## blocklist-bloom-filter

**What it is:** Informational log. Reports the blocklist bloom filter statistics after a refresh: domain count, fill ratio, estimated false positive rate, and per-source domain counts (e.g. `sources=hagezi-pro:430000,tif:489742`). Per-group blocklists include `group_id` (e.g. `group_id=kids)` to distinguish them from the global blocklist.

**Why it happens:** Normal blocklist load/refresh. No action needed.

**Multiple logs in rapid succession:** On reload or sync, the global blocklist loads first, then per-group blocklists (for client groups with custom blocklists). Each logs separately. The first entry (no `group_id`) is the global blocklist; subsequent entries with `group_id` are group-specific blocklists. Different domain counts are expected—group blocklists may have fewer sources than the global list.

**Discrepancy with UI "List entries" count:** The `domains` value in this log should match the "List entries" (and "Blocked domains" when manual blocks = 0) in the Blocklist Management UI. Both come from the same deduplicated blocklist. If you see different numbers:

1. **Different instances** — The log may be from a replica while the UI fetches stats from the primary (or vice versa). Each instance loads blocklists independently; if one instance had a partial load (e.g., one blocklist source failed), it will report fewer domains.
2. **Partial load** — If one blocklist source failed (fetch error, timeout, non-2xx), that instance will have fewer domains. Check logs for `blocklist source fetch failed`, `blocklist source parse failed`, or `blocklist source returned non-2xx`.
3. **Stale UI** — The UI shows stats from the last API fetch. If a blocklist refresh completed after you loaded the page, the log will show the new count but the UI won't until you refresh.

To verify: ensure the log and UI stats come from the same instance. In multi-instance setups, use the Multi-Instance tab to compare blocklist counts across primary and replicas.

---

## blocklist-partial-load

**What it is:** Warning log. Some blocklist sources failed to load (fetch error, timeout, parse error, non-2xx) or returned no domains despite HTTP 200, but at least one succeeded. The resolver is using a partial blocklist with fewer domains than expected.

**Why it happens:** (1) Transient network issues (startup before network is ready, CDN slowness). (2) A source returns HTTP 200 but with empty content or an error page (CDN cache, rate limit, redirect to wrong URL)—this does *not* count as a fetch failure, so previously no warning was logged; it is now detected as "empty source".

**What to do:** Click "Apply changes" in Blocklist Management to trigger a reload. If the issue persists, check logs for `blocklist source fetch failed`, `blocklist source parse failed`, or `blocklist source returned no domains` to identify which source failed and why. The next automatic refresh (every 6h by default) will also retry.

---

## blocklist-source-empty

**What it is:** Warning log. A blocklist source returned HTTP 200 but the response parsed to zero domains. Blocklists typically have hundreds of thousands of domains, so this usually indicates an error page, empty response, or wrong content type.

**Why it happens:** CDN served a placeholder or error page, rate limiting, redirect to wrong URL, or temporary upstream issue.

**What to do:** Reapply blocklists or wait for the next automatic refresh. If it persists, check the source URL manually (curl) and consider trying a different mirror or blocklist.

---

## sync-pull-error

**What it is:** The replica failed to pull configuration from the primary instance.

**Possible causes:**
- Network connectivity issues between replica and primary
- Primary instance is down or unreachable
- Firewall blocking the sync endpoint
- Invalid or expired sync token
- Primary returned non-200 (e.g. 401 Unauthorized, 503 Service Unavailable)

**What to do:** Verify network connectivity, check that the primary is running, validate the sync token, and ensure the primary's control server is accessible.

---

## sync-blocklist-reload-error

**What it is:** After pulling config from primary, the blocklist failed to reload on the replica.

**Possible causes:**
- Blocklist source URLs are unreachable
- Invalid blocklist format (e.g. malformed hosts file or domain list)
- Disk or permission issues writing blocklist cache
- One or more blocklist sources returned errors

**What to do:** Check blocklist source URLs, validate blocklist format, ensure disk space and write permissions.

---

## sync-local-records-reload-error

**What it is:** After pulling config from primary, local records failed to reload on the replica.

**Possible causes:**
- Invalid local record configuration (e.g. malformed DNS records)
- Conflicting or duplicate record definitions
- Invalid record type or value for a domain

**What to do:** Review local records configuration in the primary, fix any invalid entries.

---

## sync-stats-error

**What it is:** The replica failed to push stats (blocklist counts, cache stats) to the primary.

**Possible causes:**
- Network error when posting to `/sync/stats`
- Primary returned non-200
- JSON marshal or request creation failure

**What to do:** Check network connectivity to primary, verify primary is accepting stats.

---

## sync-stats-source-fetch-error

**What it is:** Failed to fetch query summary or latency from `stats_source_url` (e.g. web server).

**Possible causes:**
- `stats_source_url` is misconfigured or unreachable
- Web server not running or returning errors
- ClickHouse not enabled when stats endpoints require it

**What to do:** Verify `stats_source_url` in sync config, ensure the web server and stats APIs are available.

---

## sync-token-update-error

**What it is:** Could not update the sync token's `last_used` timestamp on the primary.

**Possible causes:**
- Database or persistence error on primary
- Token was revoked
- Primary returned error on the update request

**What to do:** Check primary logs, verify token is still valid.

---

## upstream-exchange-failed

**What it is:** The DNS resolver could not get a response from the upstream DNS server.

**Possible causes:**
- Upstream server is down or unreachable
- Network timeout (default upstream timeout is 10s; increase with `upstream_timeout` if you see "i/o timeout" on high-latency or congested networks)
- Upstream returned invalid or truncated response
- Firewall blocking outbound DNS (port 53)
- Wrong upstream address or port

**What to do:** Verify upstream addresses in config, test connectivity (e.g. `dig @upstream-ip example.com`), check firewall rules. If seeing frequent "i/o timeout" errors, increase `upstream_timeout` in config (e.g. `upstream_timeout: "8s"`). When multiple upstreams are configured, the resolver uses `upstream_backoff` (default 30s) to skip failed upstreams for a period, avoiding repeated timeouts on down servers. Enable trace events **query_resolution** and **upstream_exchange** in the Error Viewer for per-query debugging.

---

## cache-get-failed

**What it is:** Failed to read from the cache (Redis or in-memory).

**Possible causes:**
- Redis connection lost or timeout
- Redis WRONGTYPE (key exists with different type)
- Redis memory full or eviction issues
- Network latency to Redis

**What to do:** Check Redis connectivity and health, verify cache keys are not corrupted.

---

## cache-set-failed

**What it is:** Failed to write a DNS response to the cache.

**Possible causes:**
- Redis connection lost or timeout
- Redis out of memory
- Serialization error

**What to do:** Check Redis health and memory, ensure Redis is writable.

---

## cache-hit-counter-failed

**What it is:** Failed to increment the cache hit counter (used for refresh decisions). Non-fatal; treated as warning.

**Possible causes:**
- Redis timeout (100ms) exceeded under load
- Redis connection issues

**What to do:** Usually transient. Hit counts use a local sharded cache and return immediately; Redis is updated asynchronously. If persistent, check Redis latency and consider decreasing `hit_count_sample_rate` (e.g. `0.1`) to reduce Redis write load.

---

## sweep-hit-counter-failed

**What it is:** Failed to increment the sweep hit counter for refresh scheduling.

**Possible causes:**
- Redis timeout under load
- Redis connection issues

**What to do:** Similar to cache-hit-counter-failed; check Redis health.

---

## servfail-backoff-active

**What it is:** The resolver is in backoff for a cache key that previously returned SERVFAIL from upstream. Rate-limited per cache key (see `servfail_log_interval`) to avoid log spam.

**Possible causes:**
- Upstream had temporary issues (SERVFAIL) for this query
- Resolver avoids hammering upstream until backoff expires

**What to do:** Usually self-resolving. If persistent, investigate why upstream returns SERVFAIL for the affected domains.

---

## refresh-upstream-failed

**What it is:** Background cache refresh could not fetch an updated response from upstream (e.g. dial/connection failed when internet is down).

**Possible causes:**
- Same as upstream-exchange-failed (including "i/o timeout" when upstream is slow or network is congested)
- Upstream temporarily unavailable during refresh
- Internet or network connectivity down (dial/connection refused)

**Rate limiting:** Logs are rate-limited globally via `refresh_upstream_fail_log_interval` (default 60s) to avoid flooding when internet is down. Only one log is emitted per interval regardless of how many cache keys fail.

**What to do:** Stale data may be served if `serve_stale` is enabled. Check upstream health. If seeing high levels of "i/o timeout" across multiple upstreams, increase `upstream_timeout` in config (default 10s; try `upstream_timeout: "30s"` or higher for high-latency environments). On low-spec machines (e.g. Raspberry Pi), reduce `max_inflight` and `max_batch_size` in System Settings → Cache, and increase `sweep_interval`. Enable trace event **refresh_upstream** for per-refresh debugging.

**Connection pooling (TCP/TLS):** Errors like `err=EOF` or `err="write"` often indicate stale pooled connections. The resolver uses an idle timeout (default 30s) and retries once with a fresh connection on these errors. Optional validation (`upstream_conn_pool_validate_before_reuse: true`) probes connections before reuse; it is off by default since idle timeout + retry handle most cases. Tune `upstream_conn_pool_idle_timeout` (default 30s; 0 = no limit) if needed.

---

## refresh-servfail-backoff

**What it is:** Upstream returned SERVFAIL during a background cache refresh; the resolver is backing off for that cache key and will not retry refresh until the backoff period expires.

**Example messages:** (rate-limited per cache key via `servfail_log_interval` to avoid spam; logged at debug level, not warning)

1. **Backing off** — First SERVFAIL(s) for this cache key; resolver will retry after backoff expires:
   - `debug: refresh got SERVFAIL for dns:<domain>:<qtype>:<qclass>, backing off`

2. **Stopping retries** — SERVFAIL count reached `servfail_refresh_threshold`; resolver will no longer schedule refresh for this key. Format is `(count/threshold)`:
   - `debug: refresh got SERVFAIL for dns:<domain>:<qtype>:<qclass> (N/N), stopping retries`

The cache key format is `dns:<domain>:<qtype>:<qclass>` (e.g. domain name, record type, and class). During backoff, the resolver continues serving stale cached data if `serve_stale` is enabled; otherwise clients receive SERVFAIL.

When the SERVFAIL count reaches `servfail_refresh_threshold` (default 10), the resolver stops scheduling refresh for that key. The entry remains in cache and continues to be served (stale if `serve_stale` is enabled). Servfail logs are rate-limited per cache key (`servfail_log_interval`, default: `servfail_backoff`) to prevent log spam.

**Possible causes:**
- Upstream or authoritative server having issues for the queried domain
- DNSSEC validation failure at upstream
- Upstream misconfiguration or temporary outage

**What to do:** Monitor; backoff will expire (see `servfail_backoff` in config, default 60s). If you see "stopping retries", the domain has exceeded `servfail_refresh_threshold`. Investigate upstream if SERVFAIL is frequent. Check whether the domain's authoritative servers are healthy and DNSSEC is correctly configured.

---

## refresh-cache-set-failed

**What it is:** Failed to write refreshed DNS response to cache after a background refresh.

**Possible causes:**
- Same as cache-set-failed
- Redis timeout during refresh

**What to do:** Check Redis health; stale data may continue to be served.

---

## refresh-sweep

**What it is:** Debug/informational log. Reports refresh sweep statistics: number of candidate keys, how many were refreshed from upstream, and how many were cleaned (deleted) because they were below the `sweep_min_hits` threshold. Removed counts in stats (`last_sweep_removed_count`, `removed_24h`) also include entries evicted due to the Redis DNS key cap when over `max_keys`.

**How entries are refreshed based on candidates:**

1. **Candidate selection:** The sweeper queries the Redis expiry index for keys with soft-expiry within `sweep_window` (default 1m). Up to `max_batch_size` (default 2000) candidates are returned. Entries expiring within 30 seconds are prioritized first.

2. **Batch checks:** For each candidate, the sweeper checks in Redis: (a) whether the cache key still exists, and (b) the sweep hit count (queries in `sweep_hit_window`).

3. **Per-candidate handling:**
   - **Key missing:** Remove from expiry index (key was evicted by Redis TTL).
   - **Below `sweep_min_hits`:** Delete the key to prevent unbounded Redis growth from cold (rarely-queried) entries.
   - **Qualifying:** Schedule background refresh from upstream; the entry will be refreshed before expiry.

4. **Log fields:** `candidates` = keys considered, `refreshed` = scheduled for upstream refresh, `cleaned_below_threshold` = deleted for low hit count, `servfail_skipped` = candidates skipped because the cache key is in SERVFAIL backoff or exceeded `servfail_refresh_threshold`, `cap_evicted` = keys evicted by Redis cap (when > 0).

**Configuration:** See [Performance - Periodic Sweep Refresh](performance.md#periodic-sweep-refresh) for `sweep_window`, `sweep_min_hits`, `sweep_hit_window`, and related options.

**Why it happens:** Normal refresh sweeper operation. No action needed.

---

## refresh-sweep-failed

**What it is:** Failed during cache sweep operations (exists check, window hits, or sweep itself).

**Possible causes:**
- Redis connection or timeout issues
- Redis command failure

**What to do:** Check Redis connectivity; refresh scheduling may be affected.

---

## refresh-lock-failed

**What it is:** Failed to acquire the refresh lock before running a cache sweep/refresh.

**Possible causes:**
- Another refresh is already in progress
- Lock timeout or Redis connection issue
- Stale lock from a crashed process

**What to do:** Usually transient (another refresh running). If persistent, check Redis connectivity and whether refresh sweeps are overlapping.

---

## l0-cache-cleanup

**What it is:** Debug/informational log. The L0 (in-memory) cache removed expired entries to free memory.

**Why it happens:** Normal cache maintenance. No action needed.

---

## l0-cache-eviction

**What it is:** Debug log. The L0 (in-memory) LRU cache evicted an entry because the cache was full.

**Why it happens:** A new entry was added when the cache had reached its capacity (`lru_size`). The least recently used entry was removed to make room.

**What to do:** Normal behavior. Use when troubleshooting cache fill behavior or tuning `lru_size`.

---

## blocklist-load-failed

**What it is:** Blocklist failed to load initially or during refresh.

**Possible causes:**
- Blocklist URL unreachable
- Invalid blocklist format
- Disk or permission issues

**What to do:** Verify blocklist URLs, check format, ensure disk space.

---

## blocklist-source-status

**What it is:** A blocklist source returned a non-2xx HTTP status (e.g. 404, 500) when fetching.

**Possible causes:**
- Source URL changed or moved
- Source server temporarily unavailable
- Rate limiting or access denied

**What to do:** Check the blocklist source URL; refresh will retry on the next cycle. If persistent, update or remove the source.

---

## blocklist-health-check

**What it is:** Blocklist health check (pre-fetch URL validation) reported a source as unhealthy.

**Possible causes:**
- Source URL unreachable
- DNS resolution failure for source host
- Connection timeout

**What to do:** Verify the blocklist source URL and network connectivity.

---

## blocklist-refresh-failed

**What it is:** Blocklist refresh (periodic update) failed.

**Possible causes:**
- Same as blocklist-load-failed
- Transient network issues

**What to do:** Check blocklist sources; refresh will retry on next cycle.

---

## invalid-regex-pattern

**What it is:** A blocklist regex pattern is invalid.

**Possible causes:**
- Syntax error in regex
- Unsupported or invalid regex construct

**What to do:** Fix the regex pattern in the blocklist configuration.

---

## local-record-error

**What it is:** Error applying or looking up a local DNS record.

**Possible causes:**
- Invalid record format
- Conflicting record
- Invalid IP or record value

**What to do:** Review the local record configuration for the reported domain/type.

---

## dot-server-error

**What it is:** DoT (DNS over TLS) server encountered an error.

**Possible causes:**
- TLS handshake failure
- Certificate issues
- Port already in use

**What to do:** Verify TLS certificates, check port availability.

---

## doh-server-error

**What it is:** DoH (DNS over HTTPS) server encountered an error.

**Possible causes:**
- TLS certificate load failure
- HTTP handler error
- Port conflict

**What to do:** Check TLS cert paths, verify DoH path and configuration.

---

## control-server-error

**What it is:** The control API HTTP server encountered an error handling a request.

**Possible causes:**
- Internal handler error
- Config load/write failure
- Upstream dependency failure

**What to do:** Check control server logs for the specific error; address the underlying cause.

---

## write-response-failed

**What it is:** Failed to write a DNS response to the client.

**Possible causes:**
- Client disconnected
- Network write error
- Response too large

**What to do:** Usually transient (client disconnect). If frequent, check network stability.

---

## cache-key-cleanup-sweep-below-threshold

**What it is:** Debug log. The cache sweeper removed one or more DNS cache keys because they had fewer hits than `sweep_min_hits` within the `sweep_hit_window`. This is expected behavior to prevent unbounded Redis memory growth from cold (rarely-queried) keys.

**Why it happens:** The refresh sweeper scans for keys nearing expiration. Keys with at least `sweep_min_hits` in the sweep hit window are refreshed from upstream. Keys below that threshold are deleted instead of refreshed, since they are unlikely to be queried again soon.

**Documentation:** See [Performance - Periodic Sweep Refresh](performance.md#periodic-sweep-refresh) for `sweep_min_hits`, `sweep_hit_window`, and related configuration.

---

## query-store-buffer-full

**What it is:** Informational log. The query store (ClickHouse) buffer was full when trying to record a query event, so the event was dropped. The message reports the cumulative count of dropped events (logged every 1000th drop to avoid log spam).

**Why it happens:** Query volume exceeds the buffer's capacity to batch and flush events to ClickHouse. Common causes: ClickHouse is slow or unreachable, network latency, or a sustained burst of queries.

**What to do:** Check ClickHouse connectivity and performance. Consider increasing `batch_size` or `flush_to_store_interval` in the query store config. Monitor the `querystore_dropped_total` Prometheus metric.

---

## query-retention-set

**What it is:** Informational log. The query store successfully applied the configured TTL (retention) to the ClickHouse table. Indicates the table will automatically delete rows older than the retention period.

**Why it happens:** Normal startup or schema initialization. No action needed.

---

## clickhouse-insert-failed

**What it is:** Error when inserting query events into ClickHouse. The body may include `Database X does not exist` or `UNKNOWN_DATABASE`.

**Why it happens:** ClickHouse data was wiped (e.g. tmpfs on Raspberry Pi after a ClickHouse restart) while the app kept running. The app creates the schema at startup; if only ClickHouse restarts, the database no longer exists.

**What to do:** The app automatically reinitializes the schema (database and table) when it detects this error and retries the insert. If you see a follow-up "clickhouse database missing, reinitializing schema" log, recovery succeeded. If errors persist, check ClickHouse connectivity and ensure the app can reach it.

**Connection resilience:** On connection errors (EOF, connection reset, connection refused, timeout, DNS resolution failure), the app retries up to 3 times with backoff and closes idle connections so the next attempt uses fresh connections. The web server uses keep-alive with `retry_on_expired_socket` for query endpoints.

**Startup retry:** If ClickHouse is unreachable at startup (e.g. Docker Compose brings the DNS backend up before ClickHouse), the app retries for up to 2 minutes before giving up. This avoids permanently disabling the query store when containers start in parallel. Ensure `query_store.address` uses an IP or hostname that resolves once the network is ready; in Docker, the service name (e.g. `http://clickhouse:8123`) resolves after the network is up.

---

## No query data since reboot

**What it is:** Historical data (e.g. 6 hours ago) appears in the Query List, but no new data since a recent reboot.

**Why it happens:** The DNS backend started before ClickHouse was ready. At startup, the query store connects to ClickHouse once; if that fails, the store stays disabled for the process lifetime and no queries are recorded.

**What to do:** Restart the DNS backend (or the whole stack). The app now retries ClickHouse connection for up to 2 minutes at startup. Ensure ClickHouse is in the same Docker network and starts before or around the same time as the DNS backend. If using Docker Compose, add `depends_on: [clickhouse]` for the DNS service, or increase ClickHouse `healthcheck` so it reports healthy before dependent services start.

---

## Query store shows "disabled" on Overview (Raspberry Pi / slow startup)

**What it is:** The Overview page shows "Query store is disabled" even though the query store is enabled in config. A restart fixes it.

**Why it happens:** The DNS backend and web server start in parallel. On slower hardware (e.g. Raspberry Pi 4), the Go backend may not finish creating the ClickHouse table before the web server serves the first request. The web server queries ClickHouse directly; if the table does not exist yet, the query fails and the API returns `enabled: false`.

**What to do:** The entrypoint waits for the DNS control API (`/health`) before starting the web server when `DNS_CONTROL_URL` is set. Ensure this env var is set (e.g. `DNS_CONTROL_URL=http://127.0.0.1:8081` in Docker). When a query fails transiently (e.g. table not ready), the API returns `enabled: true` with empty data and an `error` field. The UI shows the error message and "Retrying automatically" instead of misleading "no queries". Refresh the page or wait for the next poll (every 15s); if the backend eventually connects, data will appear.
