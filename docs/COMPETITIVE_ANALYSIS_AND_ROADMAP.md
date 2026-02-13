# Competitive Analysis and Roadmap

A holistic perspective on beyond-ads-dns compared to Pi-hole, AdGuard Home, and similar solutions, with suggestions for future development.

---

## Executive Summary

**beyond-ads-dns** is a modern, high-performance ad-blocking DNS resolver built in Go. It differentiates itself through a sophisticated multi-tier caching architecture, enterprise-grade observability (ClickHouse, Prometheus, Grafana), and a clean separation between DNS resolution and blocklist filtering. While Pi-hole and AdGuard Home target broader feature sets (DHCP, parental controls, DoH/DoT), beyond-ads-dns focuses on **performance, scalability, and operational excellence** for DNS-level ad blocking.

---

## Competitive Comparison

### Feature Matrix

| Feature | beyond-ads-dns | Pi-hole | AdGuard Home |
|---------|----------------|---------|--------------|
| **Core DNS** | | | |
| UDP/TCP DNS | ✅ | ✅ | ✅ |
| DoH (DNS over HTTPS) | ❌ | ❌ | ✅ |
| DoT (DNS over TLS) | ❌ | ❌ | ✅ |
| DNSSEC validation | Via Unbound upstream | Via dnsmasq | ✅ Built-in |
| **Blocking** | | | |
| Domain blocklists | ✅ (Hagezi, etc.) | ✅ | ✅ |
| Allowlist/Denylist | ✅ | ✅ | ✅ |
| Regex rules | ✅ | ✅ | ✅ |
| Blocklist pause/resume | ✅ | ❌ | ❌ |
| **Caching** | | | |
| In-memory cache | ✅ L0 LRU | ✅ dnsmasq | ✅ |
| Distributed cache | ✅ Redis | ❌ | ❌ |
| Refresh-ahead / stale serving | ✅ | ❌ | ❌ |
| Bloom filter for blocklist | ✅ | ❌ | ❌ |
| **Observability** | | | |
| Query analytics | ✅ ClickHouse | ✅ SQLite | ✅ In-memory |
| Prometheus metrics | ✅ | ❌ | ❌ |
| Grafana dashboards | ✅ | ❌ | ❌ |
| CSV export | ✅ | ✅ | ✅ |
| **Deployment** | | | |
| Docker / Docker Compose | ✅ | ✅ | ✅ |
| Raspberry Pi optimized | ✅ | ✅ | ✅ |
| Multi-instance sync | ✅ Primary/Replica | ❌ | ❌ |
| **Additional** | | | |
| DHCP server | ❌ | ✅ | ❌ |
| Parental controls | ❌ | ❌ | ✅ |
| Safe search / Safe browsing | ❌ | ❌ | ✅ |
| Web UI | ✅ React | ✅ | ✅ |
| Let's Encrypt HTTPS | ✅ | ❌ | ✅ |
| Local DNS records | ✅ | ✅ | ✅ |

---

## Strengths of beyond-ads-dns

### 1. **Performance-First Architecture**

- **Multi-tier caching**: L0 (in-memory LRU) → L1 (Redis) → Upstream. Hot queries achieve sub-millisecond latency (10–50μs for L0 hits).
- **Bloom filter**: O(1) negative lookups for blocklist checks; 99%+ of queries skip the full map lookup.
- **Refresh-ahead + stale serving**: Proactive cache refresh and serving of stale entries during refresh avoid latency spikes.
- **Expected throughput**: 500K–1M QPS per instance for hot cache; 50K–100K for cached queries.

Pi-hole and AdGuard use simpler single-tier caching. beyond-ads-dns is built for high-QPS environments (enterprise, ISP, large home networks).

### 2. **Operational Excellence**

- **ClickHouse query store**: Time-series query analytics with retention, aggregation, and SQL. Pi-hole uses SQLite; AdGuard stores queries in memory with limited retention.
- **Prometheus + Grafana**: Native metrics and dashboards for cache hit rate, latency percentiles, block rates. Competitors lack this out of the box.
- **Control API**: Hot-reload of blocklists, upstreams, and local records without restart. Token-based auth for automation.
- **pprof**: Built-in profiling for memory and goroutine debugging.

### 3. **Scalability and HA**

- **Redis-backed cache**: Shared across instances; survives process restarts.
- **Multi-instance sync**: Primary/replica model with token auth; replicas pull DNS-affecting config from primary. Pi-hole and AdGuard have no equivalent.
- **Resolver strategies**: Failover, load-balance, weighted (by response time).

### 4. **Privacy and Flexibility**

- **Unbound integration**: Optional recursive resolution with DNSSEC; no queries to Cloudflare/Google when using Unbound upstream.
- **Configurable upstreams**: Cloudflare, Google, Quad9, or custom.
- **Local records**: Work when internet is down; useful for homelab.

### 5. **Developer Experience**

- **Go codebase**: Clean, modular, easy to extend. Single binary for DNS + control.
- **Docker-first**: Multiple compose examples (basic, Grafana, Let's Encrypt, Raspberry Pi, Unbound, max-performance).
- **Documentation**: Performance tuning, Grafana integration, instance sync, and stack evaluation docs.

---

## Gaps vs. Competitors

### 1. **No DoH/DoT**

AdGuard Home supports DNS over HTTPS and DNS over TLS for encrypted client connections. beyond-ads-dns only listens on plain UDP/TCP port 53. Users who want encrypted DNS from clients must put a DoH/DoT proxy (e.g., stunnel, caddy-dns) in front.

**Impact**: Medium. Many home users prefer DoH/DoT for privacy. Enterprise often uses VPN or trusted networks.

### 2. **No DoH/DoT Upstream**

The README lists "Add DoT/DoH upstream options" as a next step. Currently upstreams are plain DNS only. AdGuard supports `tls://` and `https://` upstreams.

**Impact**: Medium. Encrypted upstream reduces exposure to ISP/snooping. Unbound can do recursive with DNSSEC as an alternative.

### 3. **No DHCP Server**

Pi-hole includes a DHCP server for network device assignment. beyond-ads-dns does not.

**Impact**: Low for most users. DHCP is usually handled by router/OPNsense/pfSense.

### 4. **No Parental Controls / Safe Search**

AdGuard offers safe search, safe browsing, and parental control features. beyond-ads-dns is purely ad-blocking DNS.

**Impact**: Low to medium. Niche but valuable for families.

### 5. **Blocklist Format Support**

beyond-ads-dns supports hosts-style and `||domain^` rules. AdBlock-style rules (e.g., `@@||example.com^$important`) have limited support. Pi-hole and AdGuard support more rule formats.

**Impact**: Low. Hagezi and similar lists work well; advanced users may want more flexibility.

### 6. **No Built-in Block Page**

When blocking, beyond-ads-dns returns NXDOMAIN (or configurable response). Pi-hole can serve a block page. AdGuard has similar options.

**Impact**: Low. Many users prefer NXDOMAIN for simplicity.

---

## Suggested Roadmap

### Tier 1: High Impact, Align with README "Next Steps" ✅ Implemented

| Feature | Description | Status |
|---------|-------------|--------|
| **DoT/DoH upstream** | Support `tls://` and `https://` upstreams for encrypted resolution | ✅ Use `tls://host:853` for DoT, `https://host/dns-query` for DoH |
| **Structured logging** | JSON logs with query ID, qname, outcome, latency | ✅ Set `request_log.format: "json"` |
| **Query sampling** | Configurable sample rate for ClickHouse to reduce load | ✅ Set `query_store.sample_rate` (0.0–1.0) |

### Tier 2: Competitive Parity and UX

| Feature | Description | Effort | Rationale |
|---------|-------------|--------|-----------|
| **DoH/DoT server** | Accept DoH (HTTP/JSON) and DoT (TLS on 853) from clients | High | Competitive with AdGuard; enables encrypted client→resolver |
| **Block page (optional)** | Serve a simple HTML block page for blocked domains | Medium | User feedback; Pi-hole/AdGuard have this |
| **Extended blocklist formats** | Better AdBlock-style rule support | Medium | Flexibility for power users |

### Tier 3: Differentiation and Scale

| Feature | Description | Effort | Rationale |
|---------|-------------|--------|-----------|
| **Client identification** | Tag queries by client IP/name for per-device analytics | Medium | "Which device queries X?" — valuable for families/enterprise |
| **Scheduled blocklist pause** | Pause blocking during specific hours (e.g., work hours) | Low | Use case: allow work tools during day |
| **Blocklist health checks** | Validate blocklist URLs before apply; alert on fetch failure | Low | Operational reliability |
| **Redis Sentinel / Cluster** | HA for Redis in multi-instance deployments | Medium | Production HA |
| **Query anonymization** | Hash or truncate client IP for privacy-compliant retention | Low | GDPR/privacy in shared deployments |

### Tier 4: Nice-to-Have

| Feature | Description | Effort | Rationale |
|---------|-------------|--------|-----------|
| **Safe search / Safe browsing** | Redirect to safe search for Bing/Google/DuckDuckGo | Medium | Parental controls; AdGuard differentiator |
| **API for third-party integration** | Webhook on block, REST API for external tools | Low | Automation, Home Assistant, etc. |
| **Blocklist recommendations** | UI suggestions based on use case (strict/balanced/minimal) | Low | Onboarding UX |
| **Dark mode for UI** | Theme toggle | Low | Accessibility, preference |

### Tier 5: Future Exploration

| Feature | Description | Effort | Rationale |
|---------|-------------|--------|-----------|
| **QUIC (DoQ)** | DNS over QUIC for low-latency encrypted DNS | High | Emerging standard; future-proofing |
| **Response Policy Zones (RPZ)** | Support RPZ format for blocklists | Medium | Enterprise compatibility |
| **Split-horizon DNS** | Different resolution for internal vs external clients | Medium | Homelab/enterprise |
| **Geographic routing** | Prefer upstreams by client location (if ECS available) | High | CDN/GeoDNS optimization |

---

## Prioritization Framework

1. **User demand**: DoH/DoT upstream and server are frequently requested in the ad-blocking DNS space.
2. **README alignment**: DoT/DoH upstream, structured logging, query sampling are already listed.
3. **Competitive parity**: DoH/DoT, block page bring feature parity with AdGuard.
4. **Differentiation**: Multi-instance sync, ClickHouse, Grafana, and performance are already differentiators; client identification and scheduled pause add more.
5. **Effort vs. value**: Structured logging and query sampling are low effort, high value.

---

## Conclusion

**beyond-ads-dns** excels at performance, observability, and scalability. It is well-suited for:

- **Power users** who want sub-ms latency and fine-grained control
- **Homelab enthusiasts** running Unbound + blocklists with full privacy
- **Small teams / SMBs** needing multi-instance sync and Grafana dashboards
- **Developers** who prefer Go, Docker, and clean APIs

Compared to Pi-hole and AdGuard Home, beyond-ads-dns trades DHCP, parental controls, and built-in DoH/DoT for superior caching, analytics, and operational tooling. The suggested roadmap focuses on closing the DoH/DoT gap while doubling down on observability and scalability features that reinforce its strengths.
