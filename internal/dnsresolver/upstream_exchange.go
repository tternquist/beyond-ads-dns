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
	"github.com/tantalor93/doq-go/doq"
)

// doqClient interface allows resolver to hold *doq.Client without importing doq in resolver.go.
type doqClient interface {
	Send(ctx context.Context, msg *dns.Msg) (*dns.Msg, error)
}

// dohExchange performs a DNS-over-HTTPS (RFC 8484) query via HTTP POST.
// The request body is the raw DNS message (binary).
func (r *Resolver) dohExchange(req *dns.Msg, upstream Upstream) (*dns.Msg, time.Duration, error) {
	packed, err := req.Pack()
	if err != nil {
		return nil, 0, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), r.exchangeTimeout())
	defer cancel()
	start := time.Now()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, upstream.Address, bytes.NewReader(packed))
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

	timeout := r.upstreamMgr.GetTimeout()
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

// quicAddress returns the host:port for DoQ Exchange (strips quic:// prefix).
func quicAddress(address string) string {
	return strings.TrimPrefix(address, "quic://")
}

// doqClientFor returns a DNS-over-QUIC client for the given address.
// Address format: quic://host:port. RFC 9250 uses port 853 (same as DoT).
func (r *Resolver) doqClientFor(address string) doqClient {
	r.doqClientsMu.RLock()
	if c, ok := r.doqClients[address]; ok {
		r.doqClientsMu.RUnlock()
		return c
	}
	r.doqClientsMu.RUnlock()

	r.doqClientsMu.Lock()
	defer r.doqClientsMu.Unlock()
	if c, ok := r.doqClients[address]; ok {
		return c
	}

	addr := quicAddress(address)
	timeout := r.upstreamMgr.GetTimeout()
	client := doq.NewClient(addr,
		doq.WithConnectTimeout(timeout),
		doq.WithReadTimeout(timeout),
		doq.WithWriteTimeout(timeout),
	)

	if r.doqClients == nil {
		r.doqClients = make(map[string]doqClient)
	}
	r.doqClients[address] = client
	return client
}

// doqExchange performs a DNS-over-QUIC (RFC 9250) query.
func (r *Resolver) doqExchange(req *dns.Msg, upstream Upstream) (*dns.Msg, time.Duration, error) {
	client := r.doqClientFor(upstream.Address)
	ctx, cancel := context.WithTimeout(context.Background(), r.exchangeTimeout())
	defer cancel()
	start := time.Now()
	msg, err := client.Send(ctx, req)
	elapsed := time.Since(start)
	if err != nil {
		return nil, elapsed, err
	}
	return msg, elapsed, nil
}

// exchangeTimeout returns the effective upstream timeout for context-based exchanges.
// Using a context deadline bounds the total time (dial + TLS + write + read) for
// miekg/dns, which otherwise applies timeout per-phase and can exceed configured timeout.
func (r *Resolver) exchangeTimeout() time.Duration {
	return r.upstreamMgr.GetTimeout()
}

// tlsConnPoolFor returns the connection pool for the given DoT address, creating it if needed.
func (r *Resolver) tlsConnPoolFor(address string) *connPool {
	addr := dotAddress(address)
	r.tlsConnPoolsMu.RLock()
	if p, ok := r.tlsConnPools[address]; ok {
		r.tlsConnPoolsMu.RUnlock()
		return p
	}
	r.tlsConnPoolsMu.RUnlock()
	r.tlsConnPoolsMu.Lock()
	defer r.tlsConnPoolsMu.Unlock()
	if p, ok := r.tlsConnPools[address]; ok {
		return p
	}
	client := r.tlsClientFor(address)
	if client == nil {
		return nil
	}
	if r.tlsConnPools == nil {
		r.tlsConnPools = make(map[string]*connPool)
	}
	idleTimeout, validateBeforeReuse := r.upstreamMgr.GetConnPoolConfig()
	p := newConnPool(client, addr, idleTimeout, validateBeforeReuse)
	r.tlsConnPools[address] = p
	return p
}

// tcpConnPoolFor returns the connection pool for the given TCP address, creating it if needed.
func (r *Resolver) tcpConnPoolFor(address string) *connPool {
	r.tcpConnPoolsMu.RLock()
	if p, ok := r.tcpConnPools[address]; ok {
		r.tcpConnPoolsMu.RUnlock()
		return p
	}
	r.tcpConnPoolsMu.RUnlock()
	r.tcpConnPoolsMu.Lock()
	defer r.tcpConnPoolsMu.Unlock()
	if p, ok := r.tcpConnPools[address]; ok {
		return p
	}
	if r.tcpConnPools == nil {
		r.tcpConnPools = make(map[string]*connPool)
	}
	idleTimeout, validateBeforeReuse := r.upstreamMgr.GetConnPoolConfig()
	p := newConnPool(r.tcpClient, address, idleTimeout, validateBeforeReuse)
	r.tcpConnPools[address] = p
	return p
}

// exchangeWithUpstream performs a single upstream exchange for the given protocol.
// TCP and TLS use connection pooling to reuse connections and reduce handshake overhead.
func (r *Resolver) exchangeWithUpstream(req *dns.Msg, upstream Upstream) (*dns.Msg, time.Duration, error) {
	switch upstream.Protocol {
	case "https":
		return r.dohExchange(req, upstream)
	case "quic":
		return r.doqExchange(req, upstream)
	case "tls":
		pool := r.tlsConnPoolFor(upstream.Address)
		if pool == nil {
			return nil, 0, fmt.Errorf("failed to create DoT client for %s", upstream.Address)
		}
		ctx, cancel := context.WithTimeout(context.Background(), r.exchangeTimeout())
		defer cancel()
		return pool.exchange(ctx, req)
	case "udp":
		ctx, cancel := context.WithTimeout(context.Background(), r.exchangeTimeout())
		defer cancel()
		return r.udpClient.ExchangeContext(ctx, req, upstream.Address)
	case "tcp":
		pool := r.tcpConnPoolFor(upstream.Address)
		ctx, cancel := context.WithTimeout(context.Background(), r.exchangeTimeout())
		defer cancel()
		return pool.exchange(ctx, req)
	default:
		return nil, 0, fmt.Errorf("unsupported upstream protocol %q", upstream.Protocol)
	}
}

