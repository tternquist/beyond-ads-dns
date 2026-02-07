# syntax=docker/dockerfile:1

FROM golang:1.22-alpine AS build

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags "-s -w" -o /out/beyond-ads-dns ./cmd/beyond-ads-dns

FROM alpine:3.20

RUN adduser -D -g "" app

COPY --from=build /out/beyond-ads-dns /usr/local/bin/beyond-ads-dns

USER app

EXPOSE 53/udp
EXPOSE 53/tcp

ENTRYPOINT ["/usr/local/bin/beyond-ads-dns"]
