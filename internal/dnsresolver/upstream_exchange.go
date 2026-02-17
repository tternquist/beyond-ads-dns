package dnsresolver

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/miekg/dns"
)

// dohExchange performs a DNS-over-HTTPS (RFC 8484) query via HTTP POST.
// The request body is the raw DNS message (binary).
func (r *Resolver) dohExchange(req *dns.Msg, upstream Upstream) (*dns.Msg, time.Duration, error) {
	packed, err := req.Pack()
	if err != nil {
		return nil, 0, err
	}

	start := time.Now()
	httpReq, err := http.NewRequestWithContext(context.Background(), http.MethodPost, upstream.Address, bytes.NewReader(packed))
	if err != nil {
		return nil, 0, err
	}
	httpReq.Header.Set("Content-Type", "application/dns-message")
	httpReq.Header.Set("Accept", "application/dns-message")

	resp, err := r.dohClient.Do(httpReq)
	elapsed := time.Since(start)
	if err != nil {
		return nil, elapsed, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, elapsed, fmt.Errorf("DoH upstream %s returned status %d: %s", upstream.Address, resp.StatusCode, strings.TrimSpace(string(body)))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, elapsed, err
	}

	msg := new(dns.Msg)
	if err := msg.Unpack(body); err != nil {
		return nil, elapsed, fmt.Errorf("DoH response unpack: %w", err)
	}
	return msg, elapsed, nil
}

// tlsClientFor returns a DNS-over-TLS client for the given address.
// Address format: tls://host:port. The host is used for TLS ServerName (SNI).
func (r *Resolver) tlsClientFor(address string) *dns.Client {
	r.tlsClientsMu.RLock()
	if c, ok := r.tlsClients[address]; ok {
		r.tlsClientsMu.RUnlock()
		return c
	}
	r.tlsClientsMu.RUnlock()

	r.tlsClientsMu.Lock()
	defer r.tlsClientsMu.Unlock()
	if c, ok := r.tlsClients[address]; ok {
		return c
	}

	hostPort := strings.TrimPrefix(address, "tls://")
	host, _, err := net.SplitHostPort(hostPort)
	if err != nil {
		return nil
	}

	tlsConfig := &tls.Config{
		ServerName: host,
		MinVersion: tls.VersionTLS12,
	}

	timeout := r.upstreamTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second // fallback for tests that don't set config
	}
	client := &dns.Client{
		Net:       "tcp-tls",
		TLSConfig: tlsConfig,
		Timeout:   timeout,
	}

	if r.tlsClients == nil {
		r.tlsClients = make(map[string]*dns.Client)
	}
	r.tlsClients[address] = client
	return client
}

// dotAddress returns the host:port for DoT Exchange (strips tls:// prefix).
func dotAddress(address string) string {
	return strings.TrimPrefix(address, "tls://")
}

// exchangeWithUpstream performs a single upstream exchange for the given protocol.
func (r *Resolver) exchangeWithUpstream(req *dns.Msg, upstream Upstream) (*dns.Msg, time.Duration, error) {
	switch upstream.Protocol {
	case "https":
		return r.dohExchange(req, upstream)
	case "tls":
		client := r.tlsClientFor(upstream.Address)
		if client == nil {
			return nil, 0, fmt.Errorf("failed to create DoT client for %s", upstream.Address)
		}
		return client.Exchange(req, dotAddress(upstream.Address))
	case "udp":
		return r.udpClient.Exchange(req, upstream.Address)
	case "tcp":
		return r.tcpClient.Exchange(req, upstream.Address)
	default:
		return nil, 0, fmt.Errorf("unsupported upstream protocol %q", upstream.Protocol)
	}
}

