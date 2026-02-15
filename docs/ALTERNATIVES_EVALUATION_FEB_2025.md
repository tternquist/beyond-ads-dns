# Alternatives Evaluation — February 2025

A fresh assessment of beyond-ads-dns feature set compared to Pi-hole, AdGuard Home, and other ad-blocking DNS alternatives as of February 2025.

---

## Executive Summary

**beyond-ads-dns** has closed the major feature gaps identified in earlier evaluations. It now offers **full competitive parity** with AdGuard Home on core DNS features (DoH/DoT server, DoH/DoT upstream, block page, safe search) while retaining its distinct strengths: multi-tier caching, Redis-backed distributed cache, ClickHouse analytics, Prometheus/Grafana, and multi-instance sync.

**Where we stand today:**

| Dimension | Status |
|-----------|--------|
| **Core DNS** | Full parity: UDP/TCP, DoH, DoT (client + upstream) |
| **Blocking** | Parity + differentiators (blocklist pause, health checks, scheduled pause) |
| **Parental** | Parity: Safe search (Google, Bing) |
| **Observability** | **Leader**: ClickHouse, Prometheus, Grafana, webhooks |
| **Scalability** | **Leader**: Redis, multi-instance sync, Redis Sentinel/Cluster |
| **Remaining gaps** | DHCP (Pi-hole only), full parental suite (AdGuard), DoQ |

---

## Feature Matrix (Current State)

### beyond-ads-dns vs. Pi-hole vs. AdGuard Home

| Feature | beyond-ads-dns | Pi-hole | AdGuard Home |
|---------|----------------|---------|--------------|
| **Core DNS** | | | |
| UDP/TCP DNS | ✅ | ✅ | ✅ |
| DoH (client) | ✅ | ❌ | ✅ |
| DoT (client) | ✅ | ❌ | ✅ |
| DoH/DoT upstream | ✅ | ❌ | ✅ |
| DNSSEC validation | Via Unbound | Via dnsmasq | ✅ Built-in |
| **Blocking** | | | |
| Domain blocklists | ✅ (Hagezi, etc.) | ✅ | ✅ |
| Allowlist/Denylist | ✅ | ✅ | ✅ |
| Regex rules | ✅ | ✅ | ✅ |
| Blocklist pause/resume | ✅ | ❌ | ❌ |
| Scheduled blocklist pause | ✅ | ❌ | ❌ |
| Blocklist health checks | ✅ | ❌ | ❌ |
| **Caching** | | | |
| In-memory cache | ✅ L0 LRU | ✅ dnsmasq | ✅ |
| Distributed cache | ✅ Redis | ❌ | ❌ |
| Refresh-ahead / stale serving | ✅ | ❌ | ❌ |
| Bloom filter for blocklist | ✅ | ❌ | ❌ |
| **Observability** | | | |
| Query analytics | ✅ ClickHouse | ✅ SQLite | ✅ In-memory |
| Prometheus metrics | ✅ | ❌ | ❌ |
| Grafana dashboards | ✅ | ❌ | ❌ |
| Webhooks (block/error) | ✅ | ❌ | ❌ |
| Client identification | ✅ | ✅ | ✅ |
| CSV export | ✅ | ✅ | ✅ |
| **Deployment** | | | |
| Docker / Docker Compose | ✅ | ✅ | ✅ |
| Raspberry Pi optimized | ✅ | ✅ | ✅ |
| Multi-instance sync | ✅ Primary/Replica | ❌ | ❌ |
| Redis Sentinel/Cluster | ✅ | ❌ | ❌ |
| **Additional** | | | |
| DHCP server | ❌ | ✅ | ❌ |
| Parental controls (full) | ❌ | ❌ | ✅ |
| Safe search (Google/Bing) | ✅ | ❌ | ✅ |
| Block page | ✅ | ✅ | ✅ |
| Web UI | ✅ React | ✅ | ✅ |
| Dark mode | ✅ | ❌ | ❌ |
| Let's Encrypt HTTPS | ✅ | ❌ | ✅ |
| Local DNS records | ✅ | ✅ | ✅ |
| Query anonymization (GDPR) | ✅ | ❌ | ❌ |

---

## Other Alternatives (Brief)

| Solution | Type | Notable traits |
|----------|------|----------------|
| **Blocky** | Self-hosted, Go | Lightweight, supports DoH/DoT, Redis, Prometheus; simpler than beyond-ads-dns |
| **Technitium** | Self-hosted, .NET | Full DNS server, blocklists, DoH/DoT, block page; Windows/.NET focus |
| **NextDNS** | Cloud SaaS | Managed, no self-host; pay-per-query; good for users who don't want to run servers |
| **Control D** | Cloud SaaS | Similar to NextDNS; managed filtering and analytics |

beyond-ads-dns differentiates from Blocky and Technitium through its **multi-tier cache** (L0 + Redis), **ClickHouse** analytics, **multi-instance sync**, and **Grafana** integration. Blocky is lighter and simpler; Technitium targets Windows/.NET users.

---

## Remaining Gaps (as of Feb 2025)

### 1. **DHCP Server** (Pi-hole only)

Pi-hole includes a DHCP server for network device assignment. beyond-ads-dns does not.

**Impact:** Low. Most users use router/OPNsense/pfSense for DHCP.

### 2. **Full Parental Controls** (AdGuard)

AdGuard offers a broader parental suite (safe browsing API, time limits, device profiles). beyond-ads-dns has safe search (Google, Bing) only.

**Impact:** Low–medium. Safe search covers common use cases; full parental controls are niche.

### 3. **DoQ (DNS over QUIC)**

Emerging standard for low-latency encrypted DNS. Neither Pi-hole nor AdGuard has native DoQ; it is still emerging.

**Impact:** Low. DoH/DoT cover encrypted DNS today.

### 4. **Blocklist Format Breadth**

beyond-ads-dns supports hosts-style, `||domain^`, and extended AdBlock-style (`$important`, `$script`, etc.). Pi-hole and AdGuard support additional formats (e.g., RPZ, more AdBlock modifiers).

**Impact:** Low. Hagezi and similar lists work well; advanced users may want more.

---

## Strengths (Unchanged)

1. **Performance**: L0 + Redis, bloom filter, refresh-ahead, stale serving — built for high QPS.
2. **Observability**: ClickHouse, Prometheus, Grafana, webhooks (Discord, custom) — best-in-class.
3. **Scalability**: Redis Sentinel/Cluster, multi-instance sync — unique among self-hosted ad-blocking DNS.
4. **Operational**: Control API, hot-reload, blocklist health checks, scheduled pause — strong DevOps story.
5. **Privacy**: Unbound upstream, query anonymization, no third-party analytics.

---

## Conclusion

**beyond-ads-dns** has achieved **competitive parity** with AdGuard Home on core features (DoH/DoT, block page, safe search) and **exceeds** both Pi-hole and AdGuard on observability, scalability, and operational tooling. The remaining gaps (DHCP, full parental suite, DoQ) are low-priority for the target audience.

**Best fit for:**

- Power users and homelabs wanting sub-ms latency and fine-grained control
- Small teams/SMBs needing multi-instance sync and Grafana dashboards
- Users who prefer self-hosted, Go-based, Docker-first deployment
- Environments requiring Redis HA, webhooks, and GDPR-compliant query anonymization

---

*See also: [COMPETITIVE_ANALYSIS_AND_ROADMAP.md](./COMPETITIVE_ANALYSIS_AND_ROADMAP.md) for historical roadmap and Tier 5 future exploration.*
