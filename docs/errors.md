# Known Errors and Troubleshooting

This document describes errors that may appear in the Error Viewer and their possible causes.

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
- Network timeout
- Upstream returned invalid or truncated response
- Firewall blocking outbound DNS (port 53)
- Wrong upstream address or port

**What to do:** Verify upstream addresses in config, test connectivity (e.g. `dig @upstream-ip example.com`), check firewall rules.

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

**What to do:** Usually transient. If persistent, check Redis latency and consider increasing `hit_count_sample_rate` to reduce Redis load.

---

## sweep-hit-counter-failed

**What it is:** Failed to increment the sweep hit counter for refresh scheduling.

**Possible causes:**
- Redis timeout under load
- Redis connection issues

**What to do:** Similar to cache-hit-counter-failed; check Redis health.

---

## servfail-backoff-active

**What it is:** The resolver is in backoff for a cache key that previously returned SERVFAIL from upstream.

**Possible causes:**
- Upstream had temporary issues (SERVFAIL) for this query
- Resolver avoids hammering upstream until backoff expires

**What to do:** Usually self-resolving. If persistent, investigate why upstream returns SERVFAIL for the affected domains.

---

## refresh-upstream-failed

**What it is:** Background cache refresh could not fetch an updated response from upstream.

**Possible causes:**
- Same as upstream-exchange-failed
- Upstream temporarily unavailable during refresh

**What to do:** Stale data may be served if `serve_stale` is enabled. Check upstream health.

---

## refresh-servfail-backoff

**What it is:** Upstream returned SERVFAIL during a refresh; resolver is backing off for that cache key.

**Possible causes:**
- Upstream having issues for the queried domain
- Authoritative server returning SERVFAIL

**What to do:** Monitor; backoff will expire. Investigate upstream if SERVFAIL is frequent.

---

## refresh-cache-set-failed

**What it is:** Failed to write refreshed DNS response to cache after a background refresh.

**Possible causes:**
- Same as cache-set-failed
- Redis timeout during refresh

**What to do:** Check Redis health; stale data may continue to be served.

---

## refresh-sweep-failed

**What it is:** Failed during cache sweep operations (exists check, window hits, or sweep itself).

**Possible causes:**
- Redis connection or timeout issues
- Redis command failure

**What to do:** Check Redis connectivity; refresh scheduling may be affected.

---

## blocklist-load-failed

**What it is:** Blocklist failed to load initially or during refresh.

**Possible causes:**
- Blocklist URL unreachable
- Invalid blocklist format
- Disk or permission issues

**What to do:** Verify blocklist URLs, check format, ensure disk space.

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
