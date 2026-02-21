# Proposal: Initial Password Setup Code Review

**Context:** Item S4 from [code-review-next-priorities.md](./code-review-next-priorities.md) — Protect `/api/auth/set-password` when no password is configured. This proposal expands the scope to explicitly address **existing instances without a password** and **migration paths**.

---

## Current Behavior Summary

### State Detection

| Condition | `authEnabled` | `canSetInitialPassword` | `passwordEditable` |
|-----------|---------------|-------------------------|---------------------|
| No password file, no env | `false` | `true` | `true` |
| Password file exists | `true` | `false` | `true` |
| `UI_PASSWORD` or `ADMIN_PASSWORD` env set | `true` | `false` | `false` |

Password sources (in order): `UI_PASSWORD` → `ADMIN_PASSWORD` → file at `ADMIN_PASSWORD_FILE` (default `/app/config-overrides/.admin-password`).

### Initial Setup Flow (Current)

1. User opens UI → no auth required.
2. User navigates to **System Settings** → sees "Set a password to protect the UI."
3. User sets password → `POST /api/auth/set-password` with `{ newPassword }` (no auth required).
4. Server writes bcrypt hash to password file, updates in-memory `storedHash`.
5. Client does `window.location.reload()`.
6. Next load: `authEnabled=true`, login required.

---

## Concerns: Existing Instances Without a Password

### 1. Migration Definition

**"Existing instance without a password"** means:

- Instance has been running (possibly for a long time) with no password configured.
- Typical cases:
  - Fresh install from Docker Compose (default: no password).
  - Upgrade from an older version that never prompted for password.
  - Instance where password was set via env, then env was removed (e.g., config refactor).
  - Instance where password file was deleted or lost (e.g., volume not persisted).

### 2. Migration Scenarios & Risks

| Scenario | Risk | Severity |
|----------|------|----------|
| **A. Fresh install** | None. User sets password via UI as intended. | Low |
| **B. Upgrade from older version** | Same as fresh install. No explicit migration needed. | Low |
| **C. Config volume not persisted** | User sets password → file written to container FS → container restart → password lost. User must set again; no data loss, but confusing. | Medium |
| **D. Read-only config mount** | `setAdminPassword` fails with "Failed to write password file." User has no UI path; must use CLI `set-admin-password`. | Medium |
| **E. Shared network / first-access race** | Any client on the network can call `POST /api/auth/set-password` before the admin. Attacker sets password, locks out admin. | **High** (S4) |
| **F. Ephemeral/stateless deployment** | Kubernetes with emptyDir, no PVC for config. Password never persists across pod restarts. | Medium |

### 3. What "Migration" Means Here

There is **no database migration** for passwords. The password is stored in:

- A file (when not using env), or
- Environment variables.

"Migration" for existing instances = **transitioning from "no password" to "password protected"** via:

1. **UI flow** (current): User sets password in Settings.
2. **CLI flow**: `beyond-ads-dns set-admin-password` (or `docker exec ... set-admin-password`).
3. **Env flow**: Set `UI_PASSWORD` or `ADMIN_PASSWORD` before/at startup.

---

## Proposed Code Review Checklist

### Security (S4 — Primary)

- [ ] **S4.1** When `authEnabled=false` and `canSetInitialPassword=true`, `/api/auth/set-password` is unauthenticated. Document this as an intentional trade-off (first-boot convenience vs. shared-network risk).
- [ ] **S4.2** Consider adding a **setup token** or **confirmation step** (e.g., require a one-time token printed at startup, or a "I have physical access" checkbox) before allowing initial password set.
- [x] **S4.3** Add **rate limiting** on `POST /api/auth/set-password` when used for initial setup (similar to login limiter) to reduce brute-force / DoS risk. **Done.**
- [ ] **S4.4** Optionally: restrict initial password set to localhost or a configurable allowlist when no password exists.

### Migration & Persistence

- [x] **M1** Document that the password file must be on a **persistent volume** when using file-based auth. Add a note in README and docker-compose examples. **Done.**
- [ ] **M2** On `setAdminPassword` success when transitioning from no-password → password, consider logging a warning if the target directory appears ephemeral (e.g., in-memory FS). *Optional, low priority.*
- [x] **M3** When `setAdminPassword` fails (e.g., read-only filesystem), return a clear error suggesting the CLI: "Password could not be written. Use `beyond-ads-dns set-admin-password` or set UI_PASSWORD/ADMIN_PASSWORD." **Done.**
- [x] **M4** Add a **startup log** when `authEnabled=false` and `canSetInitialPassword=true`: e.g., "No admin password configured. Set one in System Settings to protect the UI." **Done.**

### UX & Documentation

- [x] **U1** Ensure the Settings page copy clearly distinguishes "Set password" (initial) vs "Change password" (existing). *Already done.*
- [x] **U2** Add a brief "Initial setup" subsection in README covering: (a) default state is no password, (b) set via UI or CLI, (c) ensure config volume is persisted in Docker/K8s. **Done.**
- [ ] **U3** Consider a **banner** when `canSetInitialPassword=true`: "Set a password to secure the dashboard" with a link to Settings. *Optional.*

### Tests

- [x] **T1** Existing test: `set-password allows initial password when auth disabled and file-based` — keep and ensure it covers the migration path.
- [x] **T2** Add test: initial password set fails when `canEditPassword()` is false (env-based). *Covered by existing "set-password rejects when password from env" test.*
- [x] **T3** Add test: rate limiting on set-password (if implemented). **Done.**
- [ ] **T4** Add test: set-password fails gracefully when target directory is read-only (if feasible in CI).

---

## Recommended Implementation Order

1. **Documentation** (M1, U2): Low effort, high clarity for operators.
2. **Startup log** (M4): Single-line change, improves visibility.
3. **Rate limiting** (S4.3): Reuse existing pattern from login.
4. **Clear error message** (M3): Improves UX when volume is read-only.
5. **Setup token / confirmation** (S4.2): Higher effort; evaluate after 1–4.

---

## Summary: Migration for Existing Instances

| Instance State | Migration Path | Notes |
|----------------|----------------|-------|
| No password, file-based | UI or CLI | Ensure config volume is persisted. |
| No password, env-based | Set `UI_PASSWORD`/`ADMIN_PASSWORD` | No migration; configure at deploy. |
| Had password, lost file | Re-set via UI or CLI | Same as initial setup. |
| Had password, env removed | Set via UI or CLI | `canEditPassword` becomes true. |

**Key takeaway:** Existing instances without a password do not require a special migration. They use the same initial-setup flow. The main risks are (a) **persistence** (volume must be mounted) and (b) **security** (unauthenticated set-password in shared networks). The proposal above addresses both.
