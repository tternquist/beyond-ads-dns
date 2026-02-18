# Known Errors and Troubleshooting

This document describes errors that may appear in the Error Viewer and their possible causes.

## Error List

- [sync-config-applied](#sync-config-applied) · [sync-config-served](#sync-config-served) · [blocklist-bloom-filter](#blocklist-bloom-filter) · [sync-pull-error](#sync-pull-error) · [sync-blocklist-reload-error](#sync-blocklist-reload-error) · [sync-local-records-reload-error](#sync-local-records-reload-error) · [sync-stats-error](#sync-stats-error) · [sync-stats-source-fetch-error](#sync-stats-source-fetch-error) · [sync-token-update-error](#sync-token-update-error) · [upstream-exchange-failed](#upstream-exchange-failed) · [cache-get-failed](#cache-get-failed) · [cache-set-failed](#cache-set-failed) · [cache-hit-counter-failed](#cache-hit-counter-failed) · [sweep-hit-counter-failed](#sweep-hit-counter-failed) · [servfail-backoff-active](#servfail-backoff-active) · [refresh-upstream-failed](#refresh-upstream-failed) · [refresh-servfail-backoff](#refresh-servfail-backoff) · [refresh-cache-set-failed](#refresh-cache-set-failed) · [refresh-sweep](#refresh-sweep) · [refresh-sweep-failed](#refresh-sweep-failed) · [refresh-lock-failed](#refresh-lock-failed) · [l0-cache-cleanup](#l0-cache-cleanup) · [blocklist-load-failed](#blocklist-load-failed) · [blocklist-source-status](#blocklist-source-status) · [blocklist-health-check](#blocklist-health-check) · [blocklist-refresh-failed](#blocklist-refresh-failed) · [invalid-regex-pattern](#invalid-regex-pattern) · [local-record-error](#local-record-error) · [dot-server-error](#dot-server-error) · [doh-server-error](#doh-server-error) · [control-server-error](#control-server-error) · [write-response-failed](#write-response-failed) · [cache-key-cleanup-sweep-below-threshold](#cache-key-cleanup-sweep-below-threshold) · [query-store-buffer-full](#query-store-buffer-full) · [query-retention-set](#query-retention-set)

---

## Log Levels

Set `control.errors.log_level` to control which messages are buffered and shown:

- **error** — Only errors (webhook-triggering)
- **warning** — Errors and warnings (default)
- **info** — Errors, warnings, and informational messages
- **debug** — All of the above plus debug events (cache cleanup, sync events, refresh sweep details)

Use `debug` when troubleshooting cache behavior, sync flows, or refresh sweeper activity.

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

**What it is:** Informational log. Reports the blocklist bloom filter statistics after a refresh: domain count, fill ratio, and estimated false positive rate.

**Why it happens:** Normal blocklist load/refresh. No action needed.

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

**What to do:** Verify upstream addresses in config, test connectivity (e.g. `dig @upstream-ip example.com`), check firewall rules. If seeing frequent "i/o timeout" errors, increase `upstream_timeout` in config (e.g. `upstream_timeout: "8s"`). When multiple upstreams are configured, the resolver uses `upstream_backoff` (default 30s) to skip failed upstreams for a period, avoiding repeated timeouts on down servers.

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

**What it is:** Background cache refresh could not fetch an updated response from upstream.

**Possible causes:**
- Same as upstream-exchange-failed (including "i/o timeout" when upstream is slow or network is congested)
- Upstream temporarily unavailable during refresh

**What to do:** Stale data may be served if `serve_stale` is enabled. Check upstream health. If seeing high levels of "i/o timeout" across multiple upstreams, increase `upstream_timeout` in config (default 10s; try `upstream_timeout: "30s"` or higher for high-latency environments).

---

## refresh-servfail-backoff

**What it is:** Upstream returned SERVFAIL during a background cache refresh; the resolver is backing off for that cache key and will not retry refresh until the backoff period expires.

**Example messages:** (rate-limited per cache key via `servfail_log_interval` to avoid spam)

1. **Backing off** — First SERVFAIL(s) for this cache key; resolver will retry after backoff expires:
   - `warning: refresh got SERVFAIL for dns:<domain>:<qtype>:<qclass>, backing off`

2. **Stopping retries** — SERVFAIL count reached `servfail_refresh_threshold`; resolver will no longer schedule refresh for this key. Format is `(count/threshold)`:
   - `warning: refresh got SERVFAIL for dns:<domain>:<qtype>:<qclass> (N/N), stopping retries`

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

**What it is:** Debug/informational log. Reports refresh sweep statistics: number of candidate keys, how many were refreshed from upstream, and how many were cleaned (deleted) because they were below the `sweep_min_hits` threshold.

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
