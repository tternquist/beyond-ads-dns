# Let's Encrypt Docker Compose

Deploy beyond-ads-dns with automatic HTTPS via Let's Encrypt for the Metrics UI.

## Prerequisites

- A domain name pointing to your server (A record)
- Ports 80 and 443 open and forwarded to the host
- No other service using port 80 (required for ACME HTTP-01 challenge)

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

## Certificate renewal

Certificates are valid for 90 days. The app automatically renews on startup when the cert expires or is within 14 days of expiry. For unattended renewal, run a periodic restart (e.g. monthly cron) or use an external renewal tool.

## Troubleshooting

- **Certificate acquisition fails**: Ensure port 80 is reachable from the internet. Let's Encrypt must access `http://your-domain/.well-known/acme-challenge/...`.
- **Rate limits**: Use `LETSENCRYPT_STAGING=true` for testing. Production has a limit of 5 certs per domain per week.
- **Multiple domains**: Set `LETSENCRYPT_DOMAIN=a.example.com,b.example.com` (comma-separated).
