package dnsresolver

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"strings"
	"time"

	"github.com/miekg/dns"
	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/cache"
	"github.com/tternquist/beyond-ads-dns/internal/config"
)

const defaultUpstreamTimeout = 2 * time.Second

type Resolver struct {
	cache           *cache.RedisCache
	blocklist       *blocklist.Manager
	upstreams       []Upstream
	minTTL          time.Duration
	maxTTL          time.Duration
	negativeTTL     time.Duration
	blockedTTL      time.Duration
	blockedResponse string
	udpClient       *dns.Client
	tcpClient       *dns.Client
	logger          *log.Logger
}

func New(cfg config.Config, cacheClient *cache.RedisCache, blocklistManager *blocklist.Manager, logger *log.Logger) *Resolver {
	upstreams := make([]Upstream, 0, len(cfg.Upstreams))
	for _, upstream := range cfg.Upstreams {
		proto := strings.ToLower(strings.TrimSpace(upstream.Protocol))
		if proto == "" {
			proto = "udp"
		}
		upstreams = append(upstreams, Upstream{
			Name:     upstream.Name,
			Address:  upstream.Address,
			Protocol: proto,
		})
	}
	return &Resolver{
		cache:           cacheClient,
		blocklist:       blocklistManager,
		upstreams:       upstreams,
		minTTL:          cfg.Cache.MinTTL.Duration,
		maxTTL:          cfg.Cache.MaxTTL.Duration,
		negativeTTL:     cfg.Cache.NegativeTTL.Duration,
		blockedTTL:      cfg.Response.BlockedTTL.Duration,
		blockedResponse: cfg.Response.Blocked,
		udpClient: &dns.Client{
			Net:     "udp",
			Timeout: defaultUpstreamTimeout,
		},
		tcpClient: &dns.Client{
			Net:     "tcp",
			Timeout: defaultUpstreamTimeout,
		},
		logger: logger,
	}
}

func (r *Resolver) ServeDNS(w dns.ResponseWriter, req *dns.Msg) {
	if req == nil || len(req.Question) == 0 {
		dns.HandleFailed(w, req)
		return
	}
	question := req.Question[0]
	qname := normalizeQueryName(question.Name)

	if r.blocklist != nil && r.blocklist.IsBlocked(qname) {
		response := r.blockedReply(req, question)
		if err := w.WriteMsg(response); err != nil {
			r.logf("failed to write blocked response: %v", err)
		}
		return
	}

	cacheKey := cacheKey(qname, question.Qtype, question.Qclass)
	if r.cache != nil {
		if cached, err := r.cache.Get(context.Background(), cacheKey); err == nil && cached != nil {
			cached.Id = req.Id
			cached.Question = req.Question
			if err := w.WriteMsg(cached); err != nil {
				r.logf("failed to write cached response: %v", err)
			}
			return
		} else if err != nil {
			r.logf("cache get failed: %v", err)
		}
	}

	response, err := r.exchange(req)
	if err != nil {
		r.logf("upstream exchange failed: %v", err)
		dns.HandleFailed(w, req)
		return
	}

	ttl := responseTTL(response, r.negativeTTL)
	ttl = clampTTL(ttl, r.minTTL, r.maxTTL)
	if r.cache != nil && ttl > 0 {
		if err := r.cache.Set(context.Background(), cacheKey, response, ttl); err != nil {
			r.logf("cache set failed: %v", err)
		}
	}

	if err := w.WriteMsg(response); err != nil {
		r.logf("failed to write upstream response: %v", err)
	}
}

func (r *Resolver) exchange(req *dns.Msg) (*dns.Msg, error) {
	if len(r.upstreams) == 0 {
		return nil, errors.New("no upstreams configured")
	}
	var lastErr error
	for _, upstream := range r.upstreams {
		client := r.clientFor(upstream.Protocol)
		if client == nil {
			continue
		}
		msg := req.Copy()
		response, _, err := client.Exchange(msg, upstream.Address)
		if err != nil {
			lastErr = err
			continue
		}
		if response != nil && response.Truncated && upstream.Protocol != "tcp" {
			tcpResponse, _, tcpErr := r.tcpClient.Exchange(msg, upstream.Address)
			if tcpErr == nil && tcpResponse != nil {
				return tcpResponse, nil
			}
			lastErr = tcpErr
			continue
		}
		return response, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no upstreams reached")
	}
	return nil, lastErr
}

func (r *Resolver) blockedReply(req *dns.Msg, question dns.Question) *dns.Msg {
	resp := new(dns.Msg)
	resp.SetReply(req)
	resp.Authoritative = true

	if r.blockedResponse == "nxdomain" {
		resp.Rcode = dns.RcodeNameError
		return resp
	}

	ip := net.ParseIP(r.blockedResponse)
	if ip == nil {
		resp.Rcode = dns.RcodeNameError
		return resp
	}
	ttl := uint32(r.blockedTTL.Seconds())
	if ttl == 0 {
		ttl = 60
	}
	switch question.Qtype {
	case dns.TypeA:
		ipv4 := ip.To4()
		if ipv4 == nil {
			resp.Rcode = dns.RcodeNameError
			return resp
		}
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{
					Name:   question.Name,
					Rrtype: dns.TypeA,
					Class:  dns.ClassINET,
					Ttl:    ttl,
				},
				A: ipv4,
			},
		}
	case dns.TypeAAAA:
		ipv6 := ip.To16()
		if ipv6 == nil || ip.To4() != nil {
			resp.Rcode = dns.RcodeNameError
			return resp
		}
		resp.Answer = []dns.RR{
			&dns.AAAA{
				Hdr: dns.RR_Header{
					Name:   question.Name,
					Rrtype: dns.TypeAAAA,
					Class:  dns.ClassINET,
					Ttl:    ttl,
				},
				AAAA: ipv6,
			},
		}
	default:
		resp.Rcode = dns.RcodeNameError
	}
	return resp
}

func (r *Resolver) clientFor(protocol string) *dns.Client {
	switch protocol {
	case "udp":
		return r.udpClient
	case "tcp":
		return r.tcpClient
	default:
		return nil
	}
}

func responseTTL(msg *dns.Msg, negativeTTL time.Duration) time.Duration {
	if msg == nil {
		return 0
	}
	if msg.Rcode == dns.RcodeNameError {
		for _, rr := range msg.Ns {
			if soa, ok := rr.(*dns.SOA); ok {
				if soa.Minttl > 0 {
					return time.Duration(soa.Minttl) * time.Second
				}
				if soa.Hdr.Ttl > 0 {
					return time.Duration(soa.Hdr.Ttl) * time.Second
				}
			}
		}
		return negativeTTL
	}
	var minTTL uint32
	for _, rr := range msg.Answer {
		ttl := rr.Header().Ttl
		if minTTL == 0 || ttl < minTTL {
			minTTL = ttl
		}
	}
	if minTTL == 0 {
		return 0
	}
	return time.Duration(minTTL) * time.Second
}

func clampTTL(ttl, minTTL, maxTTL time.Duration) time.Duration {
	if ttl <= 0 {
		return ttl
	}
	if minTTL > 0 && ttl < minTTL {
		ttl = minTTL
	}
	if maxTTL > 0 && ttl > maxTTL {
		ttl = maxTTL
	}
	return ttl
}

func cacheKey(name string, qtype, qclass uint16) string {
	return fmt.Sprintf("dns:%s:%d:%d", name, qtype, qclass)
}

func normalizeQueryName(name string) string {
	trimmed := strings.TrimSpace(strings.TrimSuffix(name, "."))
	return strings.ToLower(trimmed)
}

func (r *Resolver) logf(format string, args ...interface{}) {
	if r.logger == nil {
		return
	}
	r.logger.Printf(format, args...)
}
