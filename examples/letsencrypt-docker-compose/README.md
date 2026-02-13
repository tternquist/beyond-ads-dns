# Let's Encrypt Docker Compose

Deploy beyond-ads-dns with automatic HTTPS via Let's Encrypt for the Metrics UI.

## Prerequisites

- A domain name pointing to your server (A record)
- Ports 80 and 443 open and forwarded to the host (for HTTP challenge)
- **HTTP challenge**: No other service using port 80 (required for ACME HTTP-01)
- **DNS challenge**: Port 80 not required for certificate issuance (use when behind NAT/firewall)

## Quick start

1. Copy the environment file and set your domain:

   ```bash
   cp .env.example .env
   # Edit .env: set LETSENCRYPT_DOMAIN and LETSENCRYPT_EMAIL
   ```

2. Create the config directory:

   ```bash
   mkdir -p config
   cp ../basic-docker-compose/config/config.example.yaml config/config.yaml
   ```

3. Start the stack:

   ```bash
   docker compose up -d
   ```

4. On first run, the container will obtain a certificate from Let's Encrypt. Check logs:

   ```bash
   docker compose logs -f app
   ```

5. Access the Metrics UI at `https://your-domain` (HTTP redirects to HTTPS).

## Configuration

| Variable | Required | Description |
|---------|----------|-------------|
| `LETSENCRYPT_DOMAIN` | Yes | Domain for the certificate (e.g. `dns.example.com`) |
| `LETSENCRYPT_EMAIL` | Yes | Email for Let's Encrypt notifications |
| `LETSENCRYPT_STAGING` | No | Set to `true` for testing (staging server, no rate limits) |
| `LETSENCRYPT_CERT_DIR` | No | Where to store certs (default: `/app/letsencrypt`) |
| `LETSENCRYPT_CHALLENGE_TYPE` | No | `http` (default) or `dns` – use `dns` when port 80 is not reachable |
| `LETSENCRYPT_DNS_PROPAGATION_WAIT` | No | Seconds to wait for DNS propagation (default: 120) |

## DNS challenge (alternative to HTTP-01)

Use the DNS challenge when port 80 is not publicly reachable (e.g. behind NAT, firewall, or another service uses port 80).

1. Set in `.env`:
   ```
   LETSENCRYPT_CHALLENGE_TYPE=dns
   LETSENCRYPT_DNS_PROPAGATION_WAIT=120
   ```

2. Start the stack: `docker compose up -d`

3. Check logs: `docker compose logs -f app`

4. When the app needs a new certificate, it will print TXT records to add:
   ```
   Add the following TXT records to your DNS zone:
     Record name:  _acme-challenge.your-domain.com
     Record value: <digest-value>
   ```

5. Add the TXT record(s) in your DNS provider (Cloudflare, Route53, etc.).

6. The app waits for propagation (default 120s) then completes the challenge. If it fails, increase `LETSENCRYPT_DNS_PROPAGATION_WAIT` and restart.

**Tip**: For automated renewal with DNS API (e.g. certbot-dns-cloudflare), obtain certs externally and use manual HTTPS mode (`HTTPS_ENABLED`, `SSL_CERT_FILE`, `SSL_KEY_FILE`) instead.

## Certificate renewal

Certificates are valid for 90 days. The app automatically renews on startup when the cert expires or is within 14 days of expiry. For unattended renewal, run a periodic restart (e.g. monthly cron) or use an external renewal tool.

## Troubleshooting

- **HTTP challenge fails**: Ensure port 80 is reachable from the internet. Let's Encrypt must access `http://your-domain/.well-known/acme-challenge/...`.
- **DNS challenge fails**: Verify TXT records are correct and propagated. Increase `LETSENCRYPT_DNS_PROPAGATION_WAIT` for slow DNS. Use `dig TXT _acme-challenge.your-domain.com` to verify.
- **Rate limits**: Use `LETSENCRYPT_STAGING=true` for testing. Production has a limit of 5 certs per domain per week.
- **Multiple domains**: Set `LETSENCRYPT_DOMAIN=a.example.com,b.example.com` (comma-separated). Each domain needs its own TXT record for DNS challenge.
