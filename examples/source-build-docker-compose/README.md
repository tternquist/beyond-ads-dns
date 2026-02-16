# Source Build Docker Compose

**This is not the standard approach.** Most users should use [`examples/basic-docker-compose`](../basic-docker-compose/), which uses the pre-built image from GitHub Container Registry and requires no build step.

Use this example only if you need to:

- Run custom or modified code
- Test local changes during development
- Build for a platform not covered by the published images
- Deploy in an environment that cannot pull from external registries

## Quick Start

```bash
docker compose up --build -d
```

- **DNS**: `localhost:53` (UDP/TCP)
- **Metrics UI**: http://localhost
- **Control API**: http://localhost:8081

## Build Time

Building from source takes several minutes (Go + Node.js build). The published image starts in seconds. Prefer the basic example unless you have a specific reason to build from source.

## Config and UI Updates

Same as the basic example: default config is in the image; overrides go in `./config/config.yaml` (created when you save from the UI).
