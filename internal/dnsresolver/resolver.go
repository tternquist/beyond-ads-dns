package dnsresolver

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"
	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/cache"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/metrics"
	"github.com/tternquist/beyond-ads-dns/internal/querystore"
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
	requestLogger   *log.Logger
	queryStore      querystore.Store
	refresh         refreshConfig
	refreshSem      chan struct{}
	refreshStats    *refreshStats
}

type refreshConfig struct {
	enabled        bool
	hitWindow      time.Duration
	hotThreshold   int64
	minTTL         time.Duration
	hotTTL         time.Duration
	serveStale     bool
	staleTTL       time.Duration
	lockTTL        time.Duration
	maxInflight    int
	sweepInterval  time.Duration
	sweepWindow    time.Duration
	batchSize      int
	sweepMinHits   int64
	sweepHitWindow time.Duration
}

type refreshStats struct {
	mu        sync.Mutex
	lastSweep time.Time
	lastCount int
	history   []refreshRecord
	window    time.Duration
}

type refreshRecord struct {
	at    time.Time
	count int
}

type RefreshStats struct {
	LastSweepTime      time.Time `json:"last_sweep_time"`
	LastSweepCount     int       `json:"last_sweep_count"`
	AveragePerSweep24h float64   `json:"average_per_sweep_24h"`
	Sweeps24h          int       `json:"sweeps_24h"`
	Refreshed24h       int       `json:"refreshed_24h"`
}

func New(cfg config.Config, cacheClient *cache.RedisCache, blocklistManager *blocklist.Manager, logger *log.Logger, requestLogger *log.Logger, queryStore querystore.Store) *Resolver {
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
	refreshCfg := refreshConfig{
		enabled:        cfg.Cache.Refresh.Enabled != nil && *cfg.Cache.Refresh.Enabled,
		hitWindow:      cfg.Cache.Refresh.HitWindow.Duration,
		hotThreshold:   cfg.Cache.Refresh.HotThreshold,
		minTTL:         cfg.Cache.Refresh.MinTTL.Duration,
		hotTTL:         cfg.Cache.Refresh.HotTTL.Duration,
		serveStale:     cfg.Cache.Refresh.ServeStale != nil && *cfg.Cache.Refresh.ServeStale,
		staleTTL:       cfg.Cache.Refresh.StaleTTL.Duration,
		lockTTL:        cfg.Cache.Refresh.LockTTL.Duration,
		maxInflight:    cfg.Cache.Refresh.MaxInflight,
		sweepInterval:  cfg.Cache.Refresh.SweepInterval.Duration,
		sweepWindow:    cfg.Cache.Refresh.SweepWindow.Duration,
		batchSize:      cfg.Cache.Refresh.BatchSize,
		sweepMinHits:   cfg.Cache.Refresh.SweepMinHits,
		sweepHitWindow: cfg.Cache.Refresh.SweepHitWindow.Duration,
	}
	var sem chan struct{}
	if refreshCfg.enabled && refreshCfg.maxInflight > 0 {
		sem = make(chan struct{}, refreshCfg.maxInflight)
	}
	var stats *refreshStats
	if refreshCfg.enabled {
		stats = &refreshStats{window: 24 * time.Hour}
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
		logger:        logger,
		requestLogger: requestLogger,
		queryStore:    queryStore,
		refresh:       refreshCfg,
		refreshSem:    sem,
		refreshStats:  stats,
	}
}

func (r *Resolver) ServeDNS(w dns.ResponseWriter, req *dns.Msg) {
	start := time.Now()
	if req == nil || len(req.Question) == 0 {
		dns.HandleFailed(w, req)
		r.logRequest(w, dns.Question{}, "invalid", nil, time.Since(start))
		return
	}
	question := req.Question[0]
	qname := normalizeQueryName(question.Name)

	if r.blocklist != nil && r.blocklist.IsBlocked(qname) {
		metrics.RecordBlocked()
		response := r.blockedReply(req, question)
		if err := w.WriteMsg(response); err != nil {
			r.logf("failed to write blocked response: %v", err)
		}
		r.logRequest(w, question, "blocked", response, time.Since(start))
		return
	}

	cacheKey := cacheKey(qname, question.Qtype, question.Qclass)
	if r.cache != nil {
		cacheLookupStart := time.Now()
		cached, ttl, err := r.cache.GetWithTTL(context.Background(), cacheKey)
		cacheLookupDuration := time.Since(cacheLookupStart)
		
		if err == nil && cached != nil {
			serveStale := r.refresh.enabled && r.refresh.serveStale
			staleWithin := serveStale && r.refresh.staleTTL > 0 && -ttl <= r.refresh.staleTTL
			if ttl > 0 || staleWithin {
				cached.Id = req.Id
				cached.Question = req.Question
				writeStart := time.Now()
				if err := w.WriteMsg(cached); err != nil {
					r.logf("failed to write cached response: %v", err)
				}
				writeDuration := time.Since(writeStart)
				
				// Capture total duration BEFORE doing async operations like hit counting
				// to avoid including Redis latency in client-facing metrics
				totalDuration := time.Since(start)
				
				outcome := "cached"
				if ttl <= 0 && staleWithin {
					outcome = "stale"
				}
				
				// Log the request with accurate timing (before slow operations)
				r.logRequestWithBreakdown(w, question, outcome, cached, totalDuration, cacheLookupDuration, writeDuration)
				
				// Do hit counting and refresh scheduling AFTER logging
				// These can be slow under load and shouldn't affect reported query time
				// Use short timeout to prevent blocking under high load
				hitCtx, hitCancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
				hits, err := r.cache.IncrementHit(hitCtx, cacheKey, r.refresh.hitWindow)
				hitCancel()
				if err != nil {
					r.logf("cache hit counter failed: %v", err)
				}
				if r.refresh.enabled && r.refresh.sweepHitWindow > 0 {
					sweepCtx, sweepCancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
					if _, err := r.cache.IncrementSweepHit(sweepCtx, cacheKey, r.refresh.sweepHitWindow); err != nil {
						r.logf("sweep hit counter failed: %v", err)
					}
					sweepCancel()
				}
				if ttl > 0 {
					r.maybeRefresh(req, cacheKey, ttl, hits)
				} else if staleWithin {
					r.scheduleRefresh(question, cacheKey)
				}
				return
			}
		} else if err != nil {
			r.logf("cache get failed: %v", err)
		}
	}

	response, err := r.exchange(req)
	if err != nil {
		r.logf("upstream exchange failed: %v", err)
		dns.HandleFailed(w, req)
		r.logRequest(w, question, "upstream_error", nil, time.Since(start))
		return
	}

	ttl := responseTTL(response, r.negativeTTL)
	ttl = clampTTL(ttl, r.minTTL, r.maxTTL)
	if r.cache != nil && ttl > 0 {
		if err := r.cacheSet(context.Background(), cacheKey, response, ttl); err != nil {
			r.logf("cache set failed: %v", err)
		} else if r.refresh.enabled && r.refresh.sweepHitWindow > 0 {
			if _, err := r.cache.IncrementSweepHit(context.Background(), cacheKey, r.refresh.sweepHitWindow); err != nil {
				r.logf("sweep hit counter failed: %v", err)
			}
		}
	}

	if err := w.WriteMsg(response); err != nil {
		r.logf("failed to write upstream response: %v", err)
	}
	r.logRequest(w, question, "upstream", response, time.Since(start))
}

func (r *Resolver) maybeRefresh(req *dns.Msg, cacheKey string, ttl time.Duration, hits int64) {
	if r.cache == nil || !r.refresh.enabled {
		return
	}
	if ttl <= 0 {
		return
	}
	threshold := r.refresh.minTTL
	if hits >= r.refresh.hotThreshold && r.refresh.hotTTL > 0 {
		threshold = r.refresh.hotTTL
	}
	if threshold <= 0 || ttl > threshold {
		return
	}
	r.scheduleRefresh(req.Question[0], cacheKey)
}

func (r *Resolver) refreshCache(question dns.Question, cacheKey string) {
	msg := new(dns.Msg)
	msg.SetQuestion(question.Name, question.Qtype)
	if len(msg.Question) > 0 {
		msg.Question[0].Qclass = question.Qclass
	}
	response, err := r.exchange(msg)
	if err != nil {
		r.logf("refresh upstream failed: %v", err)
		return
	}
	ttl := responseTTL(response, r.negativeTTL)
	ttl = clampTTL(ttl, r.minTTL, r.maxTTL)
	if ttl > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := r.cacheSet(ctx, cacheKey, response, ttl); err != nil {
			r.logf("refresh cache set failed: %v", err)
		}
		cancel()
	}
}

func (r *Resolver) cacheSet(ctx context.Context, cacheKey string, response *dns.Msg, ttl time.Duration) error {
	if r.cache == nil {
		return nil
	}
	return r.cache.SetWithIndex(ctx, cacheKey, response, ttl)
}

func (r *Resolver) scheduleRefresh(question dns.Question, cacheKey string) bool {
	if r.cache == nil {
		return false
	}
	if r.refreshSem != nil {
		select {
		case r.refreshSem <- struct{}{}:
		default:
			return false
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	ok, err := r.cache.TryAcquireRefresh(ctx, cacheKey, r.refresh.lockTTL)
	cancel()
	if err != nil || !ok {
		if r.refreshSem != nil {
			<-r.refreshSem
		}
		if err != nil {
			r.logf("refresh lock failed: %v", err)
		}
		return false
	}
	go func() {
		defer func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			r.cache.ReleaseRefresh(ctx, cacheKey)
			cancel()
		}()
		if r.refreshSem != nil {
			defer func() {
				<-r.refreshSem
			}()
		}
		r.refreshCache(question, cacheKey)
	}()
	return true
}

func (r *Resolver) StartRefreshSweeper(ctx context.Context) {
	if r.cache == nil || !r.refresh.enabled {
		return
	}
	if r.refresh.sweepInterval <= 0 || r.refresh.sweepWindow <= 0 || r.refresh.batchSize <= 0 {
		return
	}
	ticker := time.NewTicker(r.refresh.sweepInterval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				r.sweepRefresh(ctx)
			}
		}
	}()
}

func (r *Resolver) sweepRefresh(ctx context.Context) {
	// Clean expired entries from L0 (in-memory LRU) cache periodically.
	// Without this, expired entries accumulate until evicted by new entries,
	// wasting memory on stale data that is never served.
	_ = r.cache.CleanLRUCache()

	until := time.Now().Add(r.refresh.sweepWindow)
	candidates, err := r.cache.ExpiryCandidates(ctx, until, r.refresh.batchSize)
	if err != nil {
		r.logf("refresh sweep failed: %v", err)
		return
	}
	refreshed := 0
	for _, candidate := range candidates {
		exists, err := r.cache.Exists(ctx, candidate.Key)
		if err != nil {
			r.logf("refresh sweep exists failed: %v", err)
			continue
		}
		if !exists {
			r.cache.RemoveFromIndex(ctx, candidate.Key)
			continue
		}
		if r.refresh.sweepMinHits > 0 {
			sweepHits, err := r.cache.GetSweepHitCount(ctx, candidate.Key)
			if err != nil {
				r.logf("refresh sweep window hits failed: %v", err)
			}
			if sweepHits < r.refresh.sweepMinHits {
				// Cold key: delete to prevent unbounded Redis memory growth.
				// Keys would otherwise persist forever due to Persist() in SetWithIndex.
				r.cache.DeleteCacheKey(ctx, candidate.Key)
				continue
			}
		}
		qname, qtype, qclass, ok := parseCacheKey(candidate.Key)
		if !ok {
			r.cache.RemoveFromIndex(ctx, candidate.Key)
			continue
		}
		q := dns.Question{Name: dns.Fqdn(qname), Qtype: qtype, Qclass: qclass}
		if r.scheduleRefresh(q, candidate.Key) {
			refreshed++
		}
	}
	if r.refreshStats != nil {
		r.refreshStats.record(refreshed)
	}
	metrics.RecordRefreshSweep(refreshed)
}

func (r *Resolver) RefreshStats() RefreshStats {
	if r.refreshStats == nil {
		return RefreshStats{}
	}
	return r.refreshStats.snapshot()
}

func (r *Resolver) CacheStats() cache.CacheStats {
	if r.cache == nil {
		return cache.CacheStats{}
	}
	return r.cache.GetCacheStats()
}

func (r *Resolver) QueryStoreStats() querystore.StoreStats {
	if r.queryStore == nil {
		return querystore.StoreStats{}
	}
	return r.queryStore.Stats()
}

func (s *refreshStats) record(count int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	s.lastSweep = now
	s.lastCount = count
	s.history = append(s.history, refreshRecord{at: now, count: count})
	cutoff := now.Add(-s.window)
	pruned := s.history[:0]
	for _, record := range s.history {
		if record.at.After(cutoff) {
			pruned = append(pruned, record)
		}
	}
	s.history = pruned
}

func (s *refreshStats) snapshot() RefreshStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.history) == 0 {
		return RefreshStats{
			LastSweepTime:      s.lastSweep,
			LastSweepCount:     s.lastCount,
			AveragePerSweep24h: 0,
			Sweeps24h:          0,
			Refreshed24h:       0,
		}
	}
	total := 0
	for _, record := range s.history {
		total += record.count
	}
	avg := float64(total) / float64(len(s.history))
	return RefreshStats{
		LastSweepTime:      s.lastSweep,
		LastSweepCount:     s.lastCount,
		AveragePerSweep24h: avg,
		Sweeps24h:          len(s.history),
		Refreshed24h:       total,
	}
}

func parseCacheKey(key string) (string, uint16, uint16, bool) {
	if !strings.HasPrefix(key, "dns:") {
		return "", 0, 0, false
	}
	parts := strings.Split(key, ":")
	if len(parts) < 4 {
		return "", 0, 0, false
	}
	qclassStr := parts[len(parts)-1]
	qtypeStr := parts[len(parts)-2]
	qname := strings.Join(parts[1:len(parts)-2], ":")
	if qname == "" {
		return "", 0, 0, false
	}
	qtypeInt, err := strconv.Atoi(qtypeStr)
	if err != nil {
		return "", 0, 0, false
	}
	qclassInt, err := strconv.Atoi(qclassStr)
	if err != nil {
		return "", 0, 0, false
	}
	return qname, uint16(qtypeInt), uint16(qclassInt), true
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
		ttl := uint32(r.blockedTTL.Seconds())
		if ttl == 0 {
			ttl = 3600
		}
		zone := question.Name
		resp.Ns = []dns.RR{
			&dns.SOA{
				Hdr: dns.RR_Header{
					Name:   zone,
					Rrtype: dns.TypeSOA,
					Class:  dns.ClassINET,
					Ttl:    ttl,
				},
				Ns:      "ns." + zone,
				Mbox:    "hostmaster." + zone,
				Serial:  1,
				Refresh: 3600,
				Retry:   600,
				Expire:  86400,
				Minttl:  ttl,
			},
		}
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
		// For successful responses with no Answer records or TTL=0,
		// use negativeTTL to cache the response and avoid repeated upstream queries
		return negativeTTL
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

func (r *Resolver) logRequest(w dns.ResponseWriter, question dns.Question, outcome string, response *dns.Msg, duration time.Duration) {
	r.logRequestWithBreakdown(w, question, outcome, response, duration, 0, 0)
}

func (r *Resolver) logRequestWithBreakdown(w dns.ResponseWriter, question dns.Question, outcome string, response *dns.Msg, duration time.Duration, cacheLookup time.Duration, networkWrite time.Duration) {
	clientAddr := ""
	protocol := ""
	if w != nil {
		if addr := w.RemoteAddr(); addr != nil {
			clientAddr = addr.String()
			protocol = addr.Network()
			if host, _, err := net.SplitHostPort(clientAddr); err == nil {
				clientAddr = host
			}
		}
	}
	qname := normalizeQueryName(question.Name)
	if qname == "" {
		qname = "-"
	}
	qtype := dns.TypeToString[question.Qtype]
	if qtype == "" {
		qtype = fmt.Sprintf("%d", question.Qtype)
	}
	qclass := dns.ClassToString[question.Qclass]
	if qclass == "" {
		qclass = fmt.Sprintf("%d", question.Qclass)
	}
	rcode := "-"
	if response != nil {
		rcode = dns.RcodeToString[response.Rcode]
		if rcode == "" {
			rcode = fmt.Sprintf("%d", response.Rcode)
		}
	}
	durationMS := duration.Seconds() * 1000.0
	cacheLookupMS := cacheLookup.Seconds() * 1000.0
	networkWriteMS := networkWrite.Seconds() * 1000.0
	
	if r.requestLogger != nil {
		if cacheLookup > 0 || networkWrite > 0 {
			r.requestLogger.Printf("client=%s protocol=%s qname=%s qtype=%s qclass=%s outcome=%s rcode=%s duration_ms=%.3f cache_lookup_ms=%.3f network_write_ms=%.3f",
				clientAddr, protocol, qname, qtype, qclass, outcome, rcode, durationMS, cacheLookupMS, networkWriteMS)
		} else {
			r.requestLogger.Printf("client=%s protocol=%s qname=%s qtype=%s qclass=%s outcome=%s rcode=%s duration_ms=%.2f",
				clientAddr, protocol, qname, qtype, qclass, outcome, rcode, durationMS)
		}
	}
	if r.queryStore != nil {
		r.queryStore.Record(querystore.Event{
			Timestamp:       time.Now().UTC(),
			ClientIP:        clientAddr,
			Protocol:        protocol,
			QName:           qname,
			QType:           qtype,
			QClass:          qclass,
			Outcome:         outcome,
			RCode:           rcode,
			DurationMS:      durationMS,
			CacheLookupMS:   cacheLookupMS,
			NetworkWriteMS:  networkWriteMS,
		})
	}
}
