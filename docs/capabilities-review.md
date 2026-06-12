# Capabilities Review & Improvement Assessment

> Reviewed: 2026-06-12

This review inventories what the solution does today and identifies capability
gaps, organized by theme and concluded with a prioritized improvement list.
Unlike [architecture-code-review.md](./architecture-code-review.md) (code-level
findings), this document focuses on **what the product can and cannot do**.

---

## What's strong today

- **Protocols**: UDP/TCP/DoT/DoH inbound; UDP/TCP/DoT/DoH/DoQ outbound with
  connection pooling, TCP fallback on truncation, and three upstream
  strategies (failover, round-robin, EWMA-weighted).
- **Caching**: L0 sharded SIEVE cache + Redis L1 with soft expiry, hot/warm
  refresh-ahead, sweeper, stale serving, and graceful L0-only degradation when
  Redis is down (`degraded_on_unavailable`).
- **Filtering**: hosts/AdBlock/URL list formats, bloom-filter fast path, regex
  allow/deny lists (RE2, length-capped), per-group blocklists, safe search
  (Google/Bing), family time with predefined services, scheduled pause.
- **Operations**: multi-arch images, Helm chart with primary/replica sync,
  Prometheus endpoint, ClickHouse analytics with sampling/anonymization/
  retention, config migrations, Let's Encrypt, secret redaction on export,
  race-enabled CI with broad test coverage across Go/Node/React.

---

## Improvement themes

### 1. DNS protocol correctness

- **No EDNS0 handling** (`internal/` has no OPT/EDNS0 references). Client OPT
  records pass through only incidentally; the resolver doesn't negotiate UDP
  buffer sizes, doesn't manage OPT on cached responses, and refresh/sweeper
  queries go out without EDNS0. This caps UDP responses at 512 bytes in some
  paths and forces avoidable TCP fallbacks.
- **No DNSSEC story**: no validation, no AD-bit semantics, DO-bit handling
  undefined for cached entries. Near-term win: correctly pass through DO/AD
  bits and document that validation is delegated upstream (the Unbound example
  covers users who want real validation).
- **ANY queries** aren't refused per RFC 8482; **QNAME minimization** is
  absent (privacy leak to upstreams, less relevant when forwarding to a single
  trusted upstream).

### 2. Abuse protection

No per-client rate limiting, no response-rate-limiting, no protection against
being used as a UDP amplification reflector. Existing protections (SERVFAIL
backoff, log rate limiting) protect upstreams and logs, not the resolver. A
token-bucket per source IP with a configurable QPS cap, plus refusing ANY by
default, closes most of this. The implicit "deployed behind a LAN firewall"
assumption should at least be documented.

### 3. Failure resilience

- **Upstream failover is sequential and passive.** With the default 10s
  timeout, the first query after an upstream dies eats the full timeout before
  trying the next. Options in increasing effort: shorter per-attempt timeout
  with a total budget, active health probes feeding backoff state, or hedged
  parallel requests after a short delay.
- **Blocklist partial failures silently shrink coverage.** A source that 404s
  — or returns a 200 error page (counted only as an empty source, not a
  failure) — drops its domains from the snapshot until the next successful
  refresh (`internal/blocklist/manager.go:LoadOnce`). Persisting a last-good
  copy per source and falling back to it on fetch failure would make refreshes
  strictly non-regressive and fix cold-start-with-no-network. (The all-sources-
  fail case is already safe: `LoadOnce` errors out before swapping the
  snapshot.)
- **Sync has no conflict handling**: primary overwrite-wins, so local edits on
  a replica are silently lost; the channel is bearer-token over whatever
  transport is deployed (no TLS requirement, no replay protection). Document
  that replicas must treat synced sections as read-only, or reject local
  writes to synced config on replicas.

### 4. Filtering depth

| Gap | Why it matters |
|---|---|
| CNAME cloaking detection | Trackers hide behind first-party CNAMEs; without checking answer chains against the blocklist these bypass filtering entirely. The response is already in hand — checking CNAME targets in answers is cheap. |
| Conditional forwarding / split horizon | "Send `*.lan` to my router" is a top ask for home-network DNS; absence blocks hybrid/internal-domain use cases. |
| Overnight schedule windows | 22:00–06:00 is rejected by validation (`internal/config/config.go`). The two-windows workaround is poor UX; wrap-around windows are small effort. |
| YouTube Restricted Mode + more safe-search engines | Safe search covers only Google/Bing; YouTube restriction (`restrict.youtube.com`) is the most-requested parental control and is mechanically identical to existing rewrites. |
| Bulk allow/deny import-export, change audit trail | Control-plane quality of life; no audit history for policy changes today. |

### 5. Operational hardening

- **Health endpoints are shallow**: `/health` returns `{"ok": true}`
  unconditionally — probes can't see a degraded instance. Add a readiness
  endpoint reflecting Redis/ClickHouse/upstream state (keep liveness shallow
  to avoid restart storms).
- **No Prometheus latency histogram**: percentiles live only in ClickHouse, so
  Prometheus/Grafana alerting on latency is impossible. One
  `dns_query_duration_seconds` histogram closes this.
- **Helm**: no PodDisruptionBudget despite supporting replicas; no
  NetworkPolicy; container runs as root by default even though the binary has
  `cap_net_bind_service` set.
- **Control API auth is all-or-nothing** (single bearer token, no auth if
  unset, GET endpoints unthrottled). Consider a read-only token tier and a
  loud startup warning when no token is set on a non-loopback listener.
- **No documented backup story** for ClickHouse history or the override
  config beyond UI export.

---

## Priority order

1. **EDNS0 support** — correctness gap affecting real-world interop.
2. **Blocklist last-good persistence** — refresh failures become non-events.
3. **CNAME cloaking checks** — biggest filtering-efficacy win, low effort.
4. **Faster upstream failover** (per-attempt budget or hedged requests).
5. **Per-client rate limiting + RFC 8482 ANY refusal**.
6. **Deep readiness probe + Prometheus latency histogram + Helm PDB**.
7. **Overnight schedule windows + YouTube Restricted Mode**.
8. **Conditional forwarding** — bigger feature; unlocks internal-network use.
