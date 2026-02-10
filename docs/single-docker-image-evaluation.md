# Single Docker Image Evaluation

## Executive Summary

**Feasibility:** Partially feasible. You can combine the **DNS resolver** and **metrics-api** into a single image, but **Redis** and **ClickHouse** should remain separate.

**Recommendation:** Combine DNS + metrics-api into one image for deployment simplicity. Keep Redis and ClickHouse as external dependencies (or as separate images in compose). This balances ease of deployment with operational best practices.

---

## Current Architecture

| Service      | Source                    | Role                          |
|-------------|---------------------------|-------------------------------|
| **dns**     | Custom (Go, root Dockerfile) | Ad-blocking DNS resolver     |
| **metrics-api** | Custom (Node.js, web/server/Dockerfile) | REST API + React UI       |
| **redis**   | Official `redis:7-alpine`  | DNS cache backend             |
| **clickhouse** | Official `clickhouse/clickhouse-server:24.12` | Query log storage    |

Current GitHub Actions (`ghcr.yml`) builds and pushes only the **dns** image.

---

## What Can Be Combined?

### ✅ DNS + Metrics-API (Recommended)

**Feasibility:** Yes. Both are stateless application services.

**Approach:**
- Build a multi-stage Dockerfile that:
  1. Builds the Go DNS binary
  2. Builds the Node.js metrics API (client + server)
  3. Produces a final image with both binaries
- Use a process manager (e.g., `supervisord`, `tini` + custom entrypoint, or `runit`) to run both processes in one container.

**Pros:**
- Single image to build, tag, and push in GitHub Actions
- Simpler deployment (one fewer container to orchestrate)
- Fewer network hops between DNS and metrics API (both in same container)
- Single artifact for application logic

**Cons:**
- Violates “one process per container” convention
- Harder to scale DNS and metrics-api independently
- Logs from both processes mixed unless handled carefully
- Restart of one process may require restarting both

### ❌ Redis (Not Recommended to Bundle)

**Why keep separate:**
- **Stateful:** Persists data to disk; requires volumes
- **Lifecycle:** Different backup, scaling, and upgrade cadence than app code
- **Resource profile:** Memory-bound; benefits from dedicated resource limits
- **Operational:** Often run as managed service (ElastiCache, Redis Cloud) or separate container
- **Standard practice:** Data stores are almost never bundled into application images

### ❌ ClickHouse (Not Recommended to Bundle)

**Why keep separate:**
- **Stateful:** Large data directory, schema migrations
- **Heavy:** ~500MB+ base image; complex to run
- **Lifecycle:** Upgrades, migrations, backups are independent of app releases
- **Operational:** Often run as managed service or dedicated cluster

---

## Options Comparison

| Option | Description | Feasibility | Best Practice |
|--------|-------------|-------------|---------------|
| **A. Status quo** | Four separate images/services | ✅ | ✅ Good |
| **B. DNS + metrics-api combined** | One app image + Redis + ClickHouse | ✅ | ✅ Good |
| **C. All-in-one** | DNS + metrics-api + Redis + ClickHouse in one image | ⚠️ Possible | ❌ Poor |

---

## Recommended Model: Option B

### Target Architecture

```
┌─────────────────────────────────────┐
│  beyond-ads-dns (single image)      │
│  ┌─────────────┐ ┌───────────────┐  │
│  │ DNS Resolver│ │ Metrics API   │  │
│  │ (Go)        │ │ (Node.js)     │  │
│  └─────────────┘ └───────────────┘  │
└─────────────────────────────────────┘
         │                    │
         ▼                    ▼
┌──────────────┐    ┌──────────────────┐
│ Redis        │    │ ClickHouse       │
│ (official)   │    │ (official)       │
└──────────────┘    └──────────────────┘
```

### Implementation Sketch

1. **Dockerfile**
   - Multi-stage: build Go binary, build Node client + server, assemble final image
   - Add `supervisord` or a minimal shell script as entrypoint that starts both processes

2. **GitHub Actions**
   - Single build-and-push job for the combined image
   - No change to Redis/ClickHouse (use official images in compose)

3. **docker-compose.yml**
   - Replace `dns` and `metrics-api` with one service using the combined image
   - Keep `redis` and `clickhouse` as-is

### Process Manager Example

```dockerfile
# Minimal approach: shell script entrypoint
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

```bash
#!/bin/sh
set -e
/app/beyond-ads-dns &
/app/node src/index.js &
wait -n
exit $?
```

For production, consider `supervisord` or `tini` for proper signal handling and process reaping.

---

## GitHub Actions Impact

### Current (ghcr.yml)
- Builds one image: `beyond-ads-dns` (Go only)
- **Metrics-api is not built or pushed** (only built locally via compose)

### Proposed
- Build one image: `beyond-ads-dns` (Go + Node.js combined)
- Single `docker build` and push
- Slightly longer build time (Go + Node build stages)
- Simpler workflow: one context, one image

---

## Summary

| Question | Answer |
|----------|--------|
| Is it feasible? | Yes, for DNS + metrics-api. Not advisable for Redis/ClickHouse. |
| Is it good practice? | Yes for app services. No for data stores. |
| Recommended approach? | Combine DNS + metrics-api; keep Redis and ClickHouse as separate services. |
| GitHub Actions? | Single build job for the combined app image; straightforward to implement. |

---

## Implementation (Completed)

The recommended approach has been implemented:

1. **Combined Dockerfile** – Multi-stage build (Go + Node client + Node server) in `Dockerfile`
2. **Entrypoint** – `scripts/entrypoint.sh` runs both DNS and metrics API, with signal handling for graceful shutdown
3. **GitHub Actions** – `ghcr.yml` builds and pushes the single combined image (no workflow changes needed)
4. **docker-compose.yml** – Single `app` service replaces `dns` and `metrics-api`; Redis and ClickHouse unchanged
5. **Documentation** – README updated to describe the combined image
