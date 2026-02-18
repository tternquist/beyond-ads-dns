# syntax=docker/dockerfile:1
# Combined image: DNS resolver + metrics API

# --- Go DNS binary ---
FROM golang:1.24-alpine AS go-build
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags "-s -w" -o /out/beyond-ads-dns ./cmd/beyond-ads-dns

# --- React client build ---
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY web/client/package.json web/client/package-lock.json ./
RUN npm ci
COPY web/client .
RUN npm run build

# --- Final image ---
FROM node:20-alpine

RUN apk add --no-cache libcap \
    && adduser -D -g "" app \
    && mkdir -p /app/logs \
    && chown -R app /app

WORKDIR /app

# DNS binary (needs libcap for setcap)
COPY --from=go-build /out/beyond-ads-dns /app/beyond-ads-dns
RUN setcap 'cap_net_bind_service=+ep' /app/beyond-ads-dns

# Metrics API
COPY web/server/package.json web/server/package-lock.json ./
RUN npm ci --omit=dev
COPY web/server .
COPY docs /app/docs
ARG RELEASE_TAG=
RUN date -u +%Y-%m-%dT%H:%M:%SZ > /app/build-timestamp.txt \
    && echo -n "${RELEASE_TAG}" > /app/release-tag.txt
COPY --from=client-build /app/client/dist /app/public

# Embedded default config (no config dir mount required)
RUN mkdir -p /app/config
COPY --from=go-build /src/config/default.yaml /app/config/default.yaml
RUN chown -R app /app

# Entrypoint to run both processes
COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=80

EXPOSE 53/udp 53/tcp 8081 80 443

# Run as root so app can write to host-mounted config (avoids chown/PUID issues)
ENTRYPOINT ["/entrypoint.sh"]
