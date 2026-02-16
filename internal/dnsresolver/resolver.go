package dnsresolver

import (
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"math"
	"math/rand"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/miekg/dns"
	"github.com/tternquist/beyond-ads-dns/internal/anonymize"
	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/cache"
	"github.com/tternquist/beyond-ads-dns/internal/clientid"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/localrecords"
	"github.com/tternquist/beyond-ads-dns/internal/metrics"
	"github.com/tternquist/beyond-ads-dns/internal/querystore"
	"github.com/tternquist/beyond-ads-dns/internal/requestlog"
	"github.com/tternquist/beyond-ads-dns/internal/webhook"
)

const (
	defaultUpstreamTimeout     = 1 * time.Second
	refreshBatchMin            = 50
	refreshBatchAdjustInterval = 5   // sweeps between batch size adjustments
	refreshBatchIncreaseThresh = 0.8 // increase when lastCount >= this fraction of batch
	refreshBatchDecreaseThresh = 0.2 // decrease when avg < this fraction of batch
	refreshBatchIncreaseMult   = 1.25
	refreshBatchDecreaseMult   = 0.75
)

// ResolverStrategy controls how upstreams are selected for DNS queries.
// - failover: try upstreams in order, use next on error
// - load_balance: round-robin across upstreams
// - weighted: prefer faster upstreams using EWMA of response times
const (
	StrategyFailover     = "failover"
	StrategyLoadBalance  = "load_balance"
	StrategyWeighted     = "weighted"
	weightedEWMAAlpha    = 0.2
	weightedMinLatencyMS = 1.0
)

type Resolver struct {
	cache            *cache.RedisCache
	localRecords     *localrecords.Manager
	blocklist        *blocklist.Manager
	upstreams        []Upstream
	strategy         string
	minTTL           time.Duration
	maxTTL           time.Duration
	negativeTTL      time.Duration
	blockedTTL       time.Duration
	blockedResponse  string
	respectSourceTTL bool
	servfailBackoff          time.Duration
	servfailRefreshThreshold int           // 0 = no limit
	servfailUntil            map[string]time.Time
	servfailCount            map[string]int // SERVFAIL refresh attempts per key
	servfailMu               sync.RWMutex
	udpClient        *dns.Client
	tcpClient        *dns.Client
	dohClient        *http.Client
	tlsClients       map[string]*dns.Client
	tlsClientsMu     sync.RWMutex
	logger           *log.Logger
	requestLogWriter requestlog.Writer
	queryStore            querystore.Store
	queryStoreSampleRate  float64
	anonymizeClientIP     string
	clientIDResolver      *clientid.Resolver
	clientIDEnabled      bool
	refresh                  refreshConfig
	refreshSem               chan struct{}
	refreshStats             *refreshStats
	refreshBatchSize         atomic.Uint32 // dynamic batch size for sweep
	refreshSweepsSinceAdjust atomic.Uint32
	// load_balance: round-robin counter
	loadBalanceNext uint64
	// weighted: per-upstream EWMA of response time (ms), keyed by upstream address
	weightedLatency   map[string]*float64
	weightedLatencyMu sync.RWMutex
	upstreamsMu       sync.RWMutex
	responseMu        sync.RWMutex // protects blockedResponse, blockedTTL for hot-reload
	webhookOnBlock    []*webhook.Notifier
	webhookOnError    []*webhook.Notifier
	safeSearchMu      sync.RWMutex
	safeSearchMap     map[string]string // qname (lower) -> CNAME target
}

type refreshConfig struct {
	enabled             bool
	hitWindow           time.Duration
	hotThreshold        int64
	minTTL              time.Duration
	hotTTL              time.Duration
	serveStale          bool
	staleTTL            time.Duration
	lockTTL             time.Duration
	maxInflight         int
	sweepInterval       time.Duration
	sweepWindow         time.Duration
	maxBatchSize        int
	sweepMinHits         int64
	sweepHitWindow       time.Duration
	batchStatsWindow    time.Duration
	hitCountSampleRate  float64
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
	LastSweepTime       time.Time `json:"last_sweep_time"`
	LastSweepCount      int       `json:"last_sweep_count"`
	AveragePerSweep24h  float64   `json:"average_per_sweep_24h"`
	StdDevPerSweep24h   float64   `json:"std_dev_per_sweep_24h"`
	Sweeps24h           int       `json:"sweeps_24h"`
	Refreshed24h        int       `json:"refreshed_24h"`
	BatchSize           int       `json:"batch_size"` // current dynamic batch size
	BatchStatsWindowSec int       `json:"batch_stats_window_sec"` // actual window used (seconds)
}

func New(cfg config.Config, cacheClient *cache.RedisCache, localRecordsManager *localrecords.Manager, blocklistManager *blocklist.Manager, logger *log.Logger, requestLogWriter requestlog.Writer, queryStore querystore.Store) *Resolver {
	upstreams := make([]Upstream, 0, len(cfg.Upstreams))
	for _, upstream := range cfg.Upstreams {
		proto := strings.ToLower(strings.TrimSpace(upstream.Protocol))
		if proto == "" {
			if strings.HasPrefix(upstream.Address, "tls://") {
				proto = "tls"
			} else if strings.HasPrefix(upstream.Address, "https://") {
				proto = "https"
			} else {
				proto = "udp"
			}
		}
		upstreams = append(upstreams, Upstream{
			Name:     upstream.Name,
			Address:  upstream.Address,
			Protocol: proto,
		})
	}
		refreshCfg := refreshConfig{
			enabled:            cfg.Cache.Refresh.Enabled != nil && *cfg.Cache.Refresh.Enabled,
			hitWindow:          cfg.Cache.Refresh.HitWindow.Duration,
			hotThreshold:       cfg.Cache.Refresh.HotThreshold,
			minTTL:             cfg.Cache.Refresh.MinTTL.Duration,
			hotTTL:             cfg.Cache.Refresh.HotTTL.Duration,
			serveStale:         cfg.Cache.Refresh.ServeStale != nil && *cfg.Cache.Refresh.ServeStale,
			staleTTL:           cfg.Cache.Refresh.StaleTTL.Duration,
			lockTTL:            cfg.Cache.Refresh.LockTTL.Duration,
			maxInflight:        cfg.Cache.Refresh.MaxInflight,
			sweepInterval:      cfg.Cache.Refresh.SweepInterval.Duration,
			sweepWindow:        cfg.Cache.Refresh.SweepWindow.Duration,
			maxBatchSize:       cfg.Cache.Refresh.MaxBatchSize,
			sweepMinHits:       cfg.Cache.Refresh.SweepMinHits,
			sweepHitWindow:     cfg.Cache.Refresh.SweepHitWindow.Duration,
			batchStatsWindow:   cfg.Cache.Refresh.BatchStatsWindow.Duration,
			hitCountSampleRate: cfg.Cache.Refresh.HitCountSampleRate,
		}
	var sem chan struct{}
	if refreshCfg.enabled && refreshCfg.maxInflight > 0 {
		sem = make(chan struct{}, refreshCfg.maxInflight)
	}
	var stats *refreshStats
	if refreshCfg.enabled {
		window := refreshCfg.batchStatsWindow
		if window <= 0 {
			window = 2 * time.Hour
		}
		stats = &refreshStats{window: window}
	}

	respectSourceTTL := cfg.Cache.RespectSourceTTL != nil && *cfg.Cache.RespectSourceTTL
	servfailBackoff := cfg.Cache.ServfailBackoff.Duration
	if servfailBackoff <= 0 {
		servfailBackoff = 60 * time.Second
	}
	servfailRefreshThreshold := 10 // default
	if cfg.Cache.ServfailRefreshThreshold != nil {
		servfailRefreshThreshold = *cfg.Cache.ServfailRefreshThreshold
		if servfailRefreshThreshold < 0 {
			servfailRefreshThreshold = 0
		}
	}

	strategy := strings.ToLower(strings.TrimSpace(cfg.ResolverStrategy))
	if strategy == "" {
		strategy = StrategyFailover
	}
	if strategy != StrategyFailover && strategy != StrategyLoadBalance && strategy != StrategyWeighted {
		strategy = StrategyFailover
	}

	weightedLatency := make(map[string]*float64)
	if strategy == StrategyWeighted {
		for _, u := range upstreams {
			init := 50.0 // start with 50ms assumed latency
			weightedLatency[u.Address] = &init
		}
	}

	clientIDEnabled := cfg.ClientIdentification.Enabled != nil && *cfg.ClientIdentification.Enabled
	var clientIDResolver *clientid.Resolver
	if clientIDEnabled && len(cfg.ClientIdentification.Clients) > 0 {
		clientIDResolver = clientid.New(cfg.ClientIdentification.Clients)
	}

	r := &Resolver{
		cache:            cacheClient,
		localRecords:    localRecordsManager,
		blocklist:        blocklistManager,
		upstreams:        upstreams,
		strategy:         strategy,
		minTTL:           cfg.Cache.MinTTL.Duration,
		maxTTL:           cfg.Cache.MaxTTL.Duration,
		negativeTTL:     cfg.Cache.NegativeTTL.Duration,
		blockedTTL:      cfg.Response.BlockedTTL.Duration,
		blockedResponse: cfg.Response.Blocked,
		respectSourceTTL: respectSourceTTL,
		servfailBackoff:          servfailBackoff,
		servfailRefreshThreshold: servfailRefreshThreshold,
		servfailUntil:            make(map[string]time.Time),
		servfailCount:            make(map[string]int),
		udpClient: &dns.Client{
			Net:     "udp",
			Timeout: defaultUpstreamTimeout,
		},
		tcpClient: &dns.Client{
			Net:     "tcp",
			Timeout: defaultUpstreamTimeout,
		},
		dohClient: &http.Client{
			Timeout: doHTimeout,
			Transport: &http.Transport{
				MaxIdleConns:        10,
				MaxIdleConnsPerHost: 2,
				IdleConnTimeout:     90 * time.Second,
			},
		},
		logger:              logger,
		requestLogWriter:    requestLogWriter,
		queryStore:           queryStore,
		queryStoreSampleRate: cfg.QueryStore.SampleRate,
		anonymizeClientIP:    cfg.QueryStore.AnonymizeClientIP,
		clientIDResolver:     clientIDResolver,
		clientIDEnabled:      clientIDEnabled,
		refresh:              refreshCfg,
		refreshSem:            sem,
		refreshStats:          stats,
		weightedLatency:       weightedLatency,
	}
	webhookTarget := func(target, format string) string {
		if strings.TrimSpace(target) != "" {
			return target
		}
		return format // deprecated: format was renamed to target
	}
	parseTimeout := func(s string) time.Duration {
		if s == "" {
			return 5 * time.Second
		}
		if d, err := time.ParseDuration(s); err == nil && d > 0 {
			return d
		}
		return 5 * time.Second
	}
	var blockNotifiers []*webhook.Notifier
	if cfg.Webhooks.OnBlock != nil && cfg.Webhooks.OnBlock.Enabled != nil && *cfg.Webhooks.OnBlock.Enabled {
		for _, t := range cfg.Webhooks.OnBlock.EffectiveTargets() {
			if strings.TrimSpace(t.URL) == "" {
				continue
			}
			timeout := parseTimeout(t.Timeout)
			if timeout == 0 {
				timeout = parseTimeout(cfg.Webhooks.OnBlock.Timeout)
			}
			maxMessages, timeframe := t.EffectiveRateLimit(cfg.Webhooks.OnBlock.RateLimitMaxMessages, cfg.Webhooks.OnBlock.RateLimitTimeframe)
			n := webhook.NewNotifier(t.URL, timeout, webhookTarget(t.Target, t.Format), t.Context, maxMessages, timeframe)
			blockNotifiers = append(blockNotifiers, n)
		}
	}
	r.webhookOnBlock = blockNotifiers
	var errorNotifiers []*webhook.Notifier
	if cfg.Webhooks.OnError != nil && cfg.Webhooks.OnError.Enabled != nil && *cfg.Webhooks.OnError.Enabled {
		for _, t := range cfg.Webhooks.OnError.EffectiveTargets() {
			if strings.TrimSpace(t.URL) == "" {
				continue
			}
			timeout := parseTimeout(t.Timeout)
			if timeout == 0 {
				timeout = parseTimeout(cfg.Webhooks.OnError.Timeout)
			}
			maxMessages, timeframe := t.EffectiveRateLimit(cfg.Webhooks.OnError.RateLimitMaxMessages, cfg.Webhooks.OnError.RateLimitTimeframe)
			n := webhook.NewNotifier(t.URL, timeout, webhookTarget(t.Target, t.Format), t.Context, maxMessages, timeframe)
			errorNotifiers = append(errorNotifiers, n)
		}
	}
	r.webhookOnError = errorNotifiers
	safeSearchEnabled := cfg.SafeSearch.Enabled != nil && *cfg.SafeSearch.Enabled
	googleSafe := cfg.SafeSearch.Google == nil || *cfg.SafeSearch.Google
	bingSafe := cfg.SafeSearch.Bing == nil || *cfg.SafeSearch.Bing
	if safeSearchEnabled && (googleSafe || bingSafe) {
		r.safeSearchMap = make(map[string]string)
		if googleSafe {
			for _, d := range []string{"www.google.com", "google.com", "www.google.de", "google.de", "www.google.co.uk", "google.co.uk", "www.google.fr", "google.fr", "www.google.co.jp", "google.co.jp", "www.google.com.au", "google.com.au", "www.google.it", "google.it", "www.google.es", "google.es", "www.google.nl", "google.nl", "www.google.ca", "google.ca", "www.google.com.br", "google.com.br", "www.google.com.mx", "google.com.mx", "www.google.pl", "google.pl", "www.google.ru", "google.ru", "www.google.co.in", "google.co.in"} {
				r.safeSearchMap[d] = "forcesafesearch.google.com"
			}
		}
		if bingSafe {
			for _, d := range []string{"www.bing.com", "bing.com"} {
				r.safeSearchMap[d] = "strict.bing.com"
			}
		}
	}
	if refreshCfg.enabled && refreshCfg.maxBatchSize > 0 {
		r.refreshBatchSize.Store(uint32(refreshCfg.maxBatchSize))
	}
	return r
}

func (r *Resolver) ServeDNS(w dns.ResponseWriter, req *dns.Msg) {
	start := time.Now()
	if req == nil || len(req.Question) == 0 {
		dns.HandleFailed(w, req)
		r.logRequest(w, dns.Question{}, "invalid", nil, time.Since(start), "")
		r.fireErrorWebhook(w, dns.Question{}, "invalid", "", "", time.Since(start))
		return
	}
	question := req.Question[0]
	qname := normalizeQueryName(question.Name)

	// Local records are checked first - they work even when internet is down
	if r.localRecords != nil {
		if response := r.localRecords.Lookup(question); response != nil {
			response.Id = req.Id
			if err := w.WriteMsg(response); err != nil {
				r.logf("failed to write local record response: %v", err)
			}
			r.logRequest(w, question, "local", response, time.Since(start), "")
			return
		}
	}

	// Safe search: rewrite search engine domains to force safe search (parental controls)
	r.safeSearchMu.RLock()
	safeSearchMap := r.safeSearchMap
	r.safeSearchMu.RUnlock()
	if len(safeSearchMap) > 0 && (question.Qtype == dns.TypeA || question.Qtype == dns.TypeAAAA) {
		if target, ok := safeSearchMap[qname]; ok {
			response := r.safeSearchReply(req, question, target)
			if response != nil {
				if err := w.WriteMsg(response); err != nil {
					r.logf("failed to write safe search response: %v", err)
				}
				r.logRequest(w, question, "safe_search", response, time.Since(start), "")
				return
			}
		}
	}

	if r.blocklist != nil && r.blocklist.IsBlocked(qname) {
		metrics.RecordBlocked()
		clientAddr := ""
		if w != nil {
			if addr := w.RemoteAddr(); addr != nil {
				clientAddr = addr.String()
				if host, _, err := net.SplitHostPort(clientAddr); err == nil {
					clientAddr = host
				}
			}
		}
		for _, n := range r.webhookOnBlock {
			n.FireOnBlock(qname, clientAddr)
		}
		response := r.blockedReply(req, question)
		if err := w.WriteMsg(response); err != nil {
			r.logf("failed to write blocked response: %v", err)
		}
		r.logRequest(w, question, "blocked", response, time.Since(start), "")
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
				r.logRequestWithBreakdown(w, question, outcome, cached, totalDuration, cacheLookupDuration, writeDuration, "")
				
				// Do hit counting and refresh scheduling in background to avoid blocking
				// the request handler. At high QPS, Redis IncrementHit/IncrementSweepHit
				// can become a bottleneck. hit_count_sample_rate reduces Redis load.
				sampleRate := r.refresh.hitCountSampleRate
				if sampleRate < 1.0 && rand.Float64() >= sampleRate {
					return
				}
				key, hitWin, sweepWin := cacheKey, r.refresh.hitWindow, r.refresh.sweepHitWindow
				refreshEnabled := r.refresh.enabled
				go func() {
					hitCtx, hitCancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
					hits, err := r.cache.IncrementHit(hitCtx, key, hitWin)
					hitCancel()
					if err != nil {
						r.logf("cache hit counter failed: %v", err)
					}
					if refreshEnabled && sweepWin > 0 {
						sweepCtx, sweepCancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
						if _, err := r.cache.IncrementSweepHit(sweepCtx, key, sweepWin); err != nil {
							r.logf("sweep hit counter failed: %v", err)
						}
						sweepCancel()
					}
					// Scale hits for refresh decision when sampling (Redis count is sampled)
					effectiveHits := hits
					if sampleRate < 1.0 && sampleRate > 0 {
						effectiveHits = int64(float64(hits) / sampleRate)
					}
					if ttl > 0 {
						r.maybeRefresh(question, key, ttl, effectiveHits)
					} else if staleWithin {
						r.scheduleRefresh(question, key)
					}
				}()
				return
			}
		} else if err != nil {
			r.logf("cache get failed: %v", err)
		}
	}

	// Check SERVFAIL backoff: if we recently got SERVFAIL for this key, return it without hitting upstream.
	if r.servfailBackoff > 0 {
		if until := r.getServfailBackoffUntil(cacheKey); until.After(time.Now()) {
			r.logf("warning: servfail backoff active for %s, returning SERVFAIL without retry", cacheKey)
			response := r.servfailReply(req)
			if err := w.WriteMsg(response); err != nil {
				r.logf("failed to write servfail response: %v", err)
			}
			r.logRequest(w, question, "servfail_backoff", response, time.Since(start), "")
			r.fireErrorWebhook(w, question, "servfail_backoff", "", "", time.Since(start))
			return
		}
	}

	response, upstreamAddr, err := r.exchange(req)
	if err != nil {
		r.logf("upstream exchange failed: %v", err)
		dns.HandleFailed(w, req)
		r.logRequest(w, question, "upstream_error", nil, time.Since(start), "")
		r.fireErrorWebhook(w, question, "upstream_error", upstreamAddr, err.Error(), time.Since(start))
		return
	}

	// SERVFAIL: don't cache, record backoff, return to client
	if response.Rcode == dns.RcodeServerFailure {
		if r.servfailBackoff > 0 {
			r.recordServfailBackoff(cacheKey)
		}
		if err := w.WriteMsg(response); err != nil {
			r.logf("failed to write servfail response: %v", err)
		}
		r.logRequest(w, question, "servfail", response, time.Since(start), upstreamAddr)
		r.fireErrorWebhook(w, question, "servfail", upstreamAddr, "", time.Since(start))
		return
	}

	ttl := responseTTL(response, r.negativeTTL)
	ttl = clampTTL(ttl, r.minTTL, r.maxTTL, r.respectSourceTTL)
	if r.cache != nil && ttl > 0 {
		if err := r.cacheSet(context.Background(), cacheKey, response, ttl); err != nil {
			r.logf("cache set failed: %v", err)
		} else if r.refresh.enabled && r.refresh.sweepHitWindow > 0 {
			// Count the initial miss as a sweep hit so entries created by a query
			// are kept within sweep_hit_window (queried = hit or miss).
			go func() {
				sweepCtx, sweepCancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
				if _, err := r.cache.IncrementSweepHit(sweepCtx, cacheKey, r.refresh.sweepHitWindow); err != nil {
					r.logf("sweep hit counter failed: %v", err)
				}
				sweepCancel()
			}()
		}
	}

	if err := w.WriteMsg(response); err != nil {
		r.logf("failed to write upstream response: %v", err)
	}
	r.logRequest(w, question, "upstream", response, time.Since(start), upstreamAddr)
}

func (r *Resolver) maybeRefresh(question dns.Question, cacheKey string, ttl time.Duration, hits int64) {
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
	r.scheduleRefresh(question, cacheKey)
}

func (r *Resolver) refreshCache(question dns.Question, cacheKey string) {
	msg := new(dns.Msg)
	msg.SetQuestion(question.Name, question.Qtype)
	if len(msg.Question) > 0 {
		msg.Question[0].Qclass = question.Qclass
	}
	response, _, err := r.exchange(msg)
	if err != nil {
		r.logf("refresh upstream failed: %v", err)
		return
	}
	// SERVFAIL: don't update cache, record backoff, keep serving stale
	if response.Rcode == dns.RcodeServerFailure {
		if r.servfailBackoff > 0 {
			r.recordServfailBackoff(cacheKey)
		}
		count := r.incrementServfailCount(cacheKey)
		if r.servfailRefreshThreshold > 0 && count >= r.servfailRefreshThreshold {
			r.logf("warning: refresh got SERVFAIL for %s (%d/%d), stopping retries", cacheKey, count, r.servfailRefreshThreshold)
		} else {
			r.logf("warning: refresh got SERVFAIL for %s, backing off", cacheKey)
		}
		return
	}
	r.clearServfailCount(cacheKey)
	ttl := responseTTL(response, r.negativeTTL)
	ttl = clampTTL(ttl, r.minTTL, r.maxTTL, r.respectSourceTTL)
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
	if r.servfailRefreshThreshold > 0 && r.getServfailCount(cacheKey) >= r.servfailRefreshThreshold {
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
	if r.refresh.sweepInterval <= 0 || r.refresh.sweepWindow <= 0 || r.refresh.maxBatchSize <= 0 {
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
				// Add 0–5s jitter to reduce lumping and alignment with other periodic processes
				jitter := time.Duration(rand.Intn(5001)) * time.Millisecond
				select {
				case <-ctx.Done():
					return
				case <-time.After(jitter):
					r.sweepRefresh(ctx)
				}
			}
		}
	}()
}

func (r *Resolver) sweepRefresh(ctx context.Context) {
	if r.cache == nil {
		return
	}
	// Flush pending sweep hits before checking counts. Otherwise, cache hits
	// that were just served may still be in the batcher (up to 50ms delay),
	// causing GetSweepHitCount to return 0 and incorrectly delete active keys.
	r.cache.FlushHitBatcher()
	// Clean expired entries from L0 (in-memory LRU) cache periodically.
	// Without this, expired entries accumulate until evicted by new entries,
	// wasting memory on stale data that is never served.
	if removed := r.cache.CleanLRUCache(); removed > 0 {
		r.logf("debug: L0 cache cleanup: %d expired entries removed", removed)
	}

	// Dynamic batch size: adjust every N sweeps based on observed workload.
	batchSize := int(r.refreshBatchSize.Load())
	if batchSize <= 0 {
		batchSize = r.refresh.maxBatchSize
	}
	if r.refreshStats != nil {
		r.maybeAdjustRefreshBatchSize(batchSize)
		batchSize = int(r.refreshBatchSize.Load())
		if batchSize <= 0 {
			batchSize = r.refresh.maxBatchSize
		}
	}

	until := time.Now().Add(r.refresh.sweepWindow)
	candidates, err := r.cache.ExpiryCandidates(ctx, until, batchSize)
	if err != nil {
		r.logf("refresh sweep failed: %v", err)
		return
	}
	// Shuffle candidates to spread downstream load across sweeps
	rand.Shuffle(len(candidates), func(i, j int) {
		candidates[i], candidates[j] = candidates[j], candidates[i]
	})
	refreshed := 0
	cleanedBelowThreshold := 0
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
				cleanedBelowThreshold++
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
	if cleanedBelowThreshold > 0 {
		r.logf("debug: cache key cleaned up (below sweep_min_hits threshold): %d keys removed", cleanedBelowThreshold)
	}
	if r.refreshStats != nil {
		r.refreshStats.record(refreshed)
		r.refreshSweepsSinceAdjust.Add(1)
	}
	metrics.RecordRefreshSweep(refreshed)
	if len(candidates) > 0 || refreshed > 0 || cleanedBelowThreshold > 0 {
		r.logf("debug: refresh sweep: %d candidates, %d refreshed, %d cleaned below threshold", len(candidates), refreshed, cleanedBelowThreshold)
	}
}

func (r *Resolver) maybeAdjustRefreshBatchSize(currentBatch int) {
	if r.refresh.maxBatchSize <= 0 {
		return
	}
	if r.refreshSweepsSinceAdjust.Load() < refreshBatchAdjustInterval {
		return
	}
	stats := r.refreshStats.snapshot()
	if stats.Sweeps24h == 0 {
		return
	}
	r.refreshSweepsSinceAdjust.Store(0)

	maxBatch := r.refresh.maxBatchSize
	if maxBatch < refreshBatchMin {
		maxBatch = refreshBatchMin
	}
	minBatch := refreshBatchMin
	if maxBatch < minBatch {
		minBatch = maxBatch
	}

	avg := stats.AveragePerSweep24h
	lastCount := stats.LastSweepCount

	newBatch := currentBatch
	if float64(lastCount) >= refreshBatchIncreaseThresh*float64(currentBatch) ||
		avg >= refreshBatchIncreaseThresh*float64(currentBatch) {
		// Hitting the limit or consistently high: increase batch size
		newBatch = int(float64(currentBatch) * refreshBatchIncreaseMult)
		if newBatch > maxBatch {
			newBatch = maxBatch
		}
	} else if avg < refreshBatchDecreaseThresh*float64(currentBatch) && currentBatch > minBatch {
		// Consistently low: decrease batch size
		newBatch = int(float64(currentBatch) * refreshBatchDecreaseMult)
		if newBatch < minBatch {
			newBatch = minBatch
		}
	}
	if newBatch != currentBatch {
		r.refreshBatchSize.Store(uint32(newBatch))
	}
}

func (r *Resolver) RefreshStats() RefreshStats {
	if r.refreshStats == nil {
		return RefreshStats{}
	}
	stats := r.refreshStats.snapshot()
	stats.BatchSize = int(r.refreshBatchSize.Load())
	if stats.BatchSize <= 0 {
		stats.BatchSize = r.refresh.maxBatchSize
	}
	return stats
}

func (r *Resolver) CacheStats() cache.CacheStats {
	if r.cache == nil {
		return cache.CacheStats{}
	}
	return r.cache.GetCacheStats()
}

// ClearCache removes all DNS cache entries from Redis and the L0 LRU cache.
func (r *Resolver) ClearCache(ctx context.Context) error {
	if r.cache == nil {
		return nil
	}
	return r.cache.ClearCache(ctx)
}

func (r *Resolver) QueryStoreStats() querystore.StoreStats {
	if r.queryStore == nil {
		return querystore.StoreStats{}
	}
	return r.queryStore.Stats()
}

// ApplyUpstreamConfig updates upstreams and resolver strategy at runtime (for hot-reload).
func (r *Resolver) ApplyUpstreamConfig(cfg config.Config) {
	upstreams := make([]Upstream, 0, len(cfg.Upstreams))
	for _, u := range cfg.Upstreams {
		proto := strings.ToLower(strings.TrimSpace(u.Protocol))
		if proto == "" {
			if strings.HasPrefix(u.Address, "tls://") {
				proto = "tls"
			} else if strings.HasPrefix(u.Address, "https://") {
				proto = "https"
			} else {
				proto = "udp"
			}
		}
		upstreams = append(upstreams, Upstream{
			Name:     u.Name,
			Address:  u.Address,
			Protocol: proto,
		})
	}
	strategy := strings.ToLower(strings.TrimSpace(cfg.ResolverStrategy))
	if strategy == "" {
		strategy = StrategyFailover
	}
	if strategy != StrategyFailover && strategy != StrategyLoadBalance && strategy != StrategyWeighted {
		strategy = StrategyFailover
	}

	r.upstreamsMu.Lock()
	r.upstreams = upstreams
	r.strategy = strategy
	r.upstreamsMu.Unlock()

	// Clear TLS client cache when upstreams change (avoid stale connections)
	r.tlsClientsMu.Lock()
	r.tlsClients = nil
	r.tlsClientsMu.Unlock()

	// Update weighted latency map for new upstreams
	if strategy == StrategyWeighted {
		r.weightedLatencyMu.Lock()
		newMap := make(map[string]*float64)
		for _, u := range upstreams {
			if ptr, ok := r.weightedLatency[u.Address]; ok {
				newMap[u.Address] = ptr
			} else {
				init := 50.0
				newMap[u.Address] = &init
			}
		}
		r.weightedLatency = newMap
		r.weightedLatencyMu.Unlock()
	}
}

// UpstreamConfig returns the current upstream configuration for API/UI display.
func (r *Resolver) UpstreamConfig() ([]Upstream, string) {
	r.upstreamsMu.RLock()
	defer r.upstreamsMu.RUnlock()
	// Return a copy so caller cannot mutate
	upstreams := make([]Upstream, len(r.upstreams))
	copy(upstreams, r.upstreams)
	return upstreams, r.strategy
}

// ApplyClientIdentificationConfig updates client IP->name mappings at runtime (for hot-reload).
func (r *Resolver) ApplyClientIdentificationConfig(cfg config.Config) {
	enabled := cfg.ClientIdentification.Enabled != nil && *cfg.ClientIdentification.Enabled
	r.clientIDEnabled = enabled
	if r.clientIDResolver != nil {
		r.clientIDResolver.ApplyConfig(cfg.ClientIdentification.Clients)
	} else if enabled && len(cfg.ClientIdentification.Clients) > 0 {
		r.clientIDResolver = clientid.New(cfg.ClientIdentification.Clients)
	} else {
		r.clientIDResolver = nil
	}
}

// ApplySafeSearchConfig updates safe search map at runtime (for hot-reload and sync).
func (r *Resolver) ApplySafeSearchConfig(cfg config.Config) {
	safeSearchEnabled := cfg.SafeSearch.Enabled != nil && *cfg.SafeSearch.Enabled
	googleSafe := cfg.SafeSearch.Google == nil || *cfg.SafeSearch.Google
	bingSafe := cfg.SafeSearch.Bing == nil || *cfg.SafeSearch.Bing
	var m map[string]string
	if safeSearchEnabled && (googleSafe || bingSafe) {
		m = make(map[string]string)
		if googleSafe {
			for _, d := range []string{"www.google.com", "google.com", "www.google.de", "google.de", "www.google.co.uk", "google.co.uk", "www.google.fr", "google.fr", "www.google.co.jp", "google.co.jp", "www.google.com.au", "google.com.au", "www.google.it", "google.it", "www.google.es", "google.es", "www.google.nl", "google.nl", "www.google.ca", "google.ca", "www.google.com.br", "google.com.br", "www.google.com.mx", "google.com.mx", "www.google.pl", "google.pl", "www.google.ru", "google.ru", "www.google.co.in", "google.co.in"} {
				m[d] = "forcesafesearch.google.com"
			}
		}
		if bingSafe {
			for _, d := range []string{"www.bing.com", "bing.com"} {
				m[d] = "strict.bing.com"
			}
		}
	}
	r.safeSearchMu.Lock()
	r.safeSearchMap = m
	r.safeSearchMu.Unlock()
}

// ApplyResponseConfig updates blocked response and TTL at runtime (for hot-reload).
func (r *Resolver) ApplyResponseConfig(cfg config.Config) {
	blocked := strings.ToLower(strings.TrimSpace(cfg.Response.Blocked))
	if blocked == "" {
		blocked = "nxdomain"
	}
	ttl := cfg.Response.BlockedTTL.Duration
	if ttl <= 0 {
		ttl = time.Hour
	}
	r.responseMu.Lock()
	r.blockedResponse = blocked
	r.blockedTTL = ttl
	r.responseMu.Unlock()
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
	windowSec := int(s.window.Seconds())
	if len(s.history) == 0 {
		return RefreshStats{
			LastSweepTime:       s.lastSweep,
			LastSweepCount:      s.lastCount,
			AveragePerSweep24h:  0,
			StdDevPerSweep24h:   0,
			Sweeps24h:           0,
			Refreshed24h:        0,
			BatchStatsWindowSec: windowSec,
		}
	}
	total := 0
	for _, record := range s.history {
		total += record.count
	}
	n := float64(len(s.history))
	avg := float64(total) / n
	var sumSqDiff float64
	for _, record := range s.history {
		diff := float64(record.count) - avg
		sumSqDiff += diff * diff
	}
	stdDev := 0.0
	if n > 1 {
		stdDev = math.Sqrt(sumSqDiff / n)
	}
	return RefreshStats{
		LastSweepTime:       s.lastSweep,
		LastSweepCount:      s.lastCount,
		AveragePerSweep24h:  avg,
		StdDevPerSweep24h:   stdDev,
		Sweeps24h:           len(s.history),
		Refreshed24h:        total,
		BatchStatsWindowSec: windowSec,
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

func (r *Resolver) servfailReply(req *dns.Msg) *dns.Msg {
	resp := new(dns.Msg)
	resp.SetRcode(req, dns.RcodeServerFailure)
	return resp
}

func (r *Resolver) recordServfailBackoff(cacheKey string) {
	r.servfailMu.Lock()
	defer r.servfailMu.Unlock()
	r.servfailUntil[cacheKey] = time.Now().Add(r.servfailBackoff)
	// Prune expired entries to avoid unbounded growth
	now := time.Now()
	for k, until := range r.servfailUntil {
		if until.Before(now) {
			delete(r.servfailUntil, k)
		}
	}
}

func (r *Resolver) getServfailCount(cacheKey string) int {
	r.servfailMu.RLock()
	defer r.servfailMu.RUnlock()
	return r.servfailCount[cacheKey]
}

func (r *Resolver) incrementServfailCount(cacheKey string) int {
	r.servfailMu.Lock()
	defer r.servfailMu.Unlock()
	r.servfailCount[cacheKey]++
	return r.servfailCount[cacheKey]
}

func (r *Resolver) clearServfailCount(cacheKey string) {
	r.servfailMu.Lock()
	defer r.servfailMu.Unlock()
	delete(r.servfailCount, cacheKey)
}

func (r *Resolver) getServfailBackoffUntil(cacheKey string) time.Time {
	r.servfailMu.RLock()
	until, ok := r.servfailUntil[cacheKey]
	r.servfailMu.RUnlock()
	if !ok {
		return time.Time{}
	}
	return until
}

func (r *Resolver) exchange(req *dns.Msg) (*dns.Msg, string, error) {
	r.upstreamsMu.RLock()
	upstreams := r.upstreams
	r.upstreamsMu.RUnlock()

	if len(upstreams) == 0 {
		return nil, "", errors.New("no upstreams configured")
	}

	order := r.upstreamOrder(upstreams)
	var lastErr error
	for _, idx := range order {
		upstream := upstreams[idx]
		msg := req.Copy()
		response, elapsed, err := r.exchangeWithUpstream(msg, upstream)
		if err != nil {
			lastErr = err
			continue
		}
		if response == nil {
			continue
		}

		// Update weighted latency EWMA on success
		if r.strategy == StrategyWeighted {
			r.updateWeightedLatency(upstream.Address, elapsed)
		}

		// SERVFAIL: return immediately without trying other upstreams.
		// Indicates upstream security issue or misconfiguration; retrying aggressively is unhelpful.
		if response.Rcode == dns.RcodeServerFailure {
			return response, upstream.Address, nil
		}
		if response.Truncated && upstream.Protocol != "tcp" && upstream.Protocol != "tls" && upstream.Protocol != "https" {
			tcpResponse, _, tcpErr := r.tcpClient.Exchange(msg, upstream.Address)
			if tcpErr == nil && tcpResponse != nil {
				return tcpResponse, upstream.Address, nil
			}
			lastErr = tcpErr
			continue
		}
		return response, upstream.Address, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no upstreams reached")
	}
	return nil, "", lastErr
}

// upstreamOrder returns the order in which to try upstreams based on strategy.
func (r *Resolver) upstreamOrder(upstreams []Upstream) []int {
	switch r.strategy {
	case StrategyLoadBalance:
		n := uint64(len(upstreams))
		if n == 0 {
			return nil
		}
		next := atomic.AddUint64(&r.loadBalanceNext, 1)
		start := int(next % n)
		order := make([]int, len(upstreams))
		for i := range order {
			order[i] = (start + i) % len(upstreams)
		}
		return order
	case StrategyWeighted:
		return r.weightedOrder(upstreams)
	default:
		// failover: try in config order
		order := make([]int, len(upstreams))
		for i := range order {
			order[i] = i
		}
		return order
	}
}

func (r *Resolver) weightedOrder(upstreams []Upstream) []int {
	r.weightedLatencyMu.RLock()
	defer r.weightedLatencyMu.RUnlock()

	type scored struct {
		idx   int
		score float64
	}
	scores := make([]scored, len(upstreams))
	for i, u := range upstreams {
		lat := r.weightedLatency[u.Address]
		score := weightedMinLatencyMS
		if lat != nil && *lat > 0 {
			score = *lat
		}
		scores[i] = scored{idx: i, score: score}
	}
	// Sort by score ascending (lowest latency first)
	for i := 0; i < len(scores)-1; i++ {
		for j := i + 1; j < len(scores); j++ {
			if scores[j].score < scores[i].score {
				scores[i], scores[j] = scores[j], scores[i]
			}
		}
	}
	order := make([]int, len(upstreams))
	for i, s := range scores {
		order[i] = s.idx
	}
	return order
}

func (r *Resolver) updateWeightedLatency(address string, elapsed time.Duration) {
	ms := elapsed.Seconds() * 1000
	if ms < weightedMinLatencyMS {
		ms = weightedMinLatencyMS
	}
	r.weightedLatencyMu.Lock()
	defer r.weightedLatencyMu.Unlock()
	ptr := r.weightedLatency[address]
	if ptr != nil {
		*ptr = weightedEWMAAlpha*ms + (1-weightedEWMAAlpha)*(*ptr)
	}
}

func (r *Resolver) safeSearchReply(req *dns.Msg, question dns.Question, target string) *dns.Msg {
	resp := new(dns.Msg)
	resp.SetReply(req)
	resp.Authoritative = true
	resp.RecursionAvailable = true
	ttl := uint32(300) // 5 min
	cname := &dns.CNAME{
		Hdr: dns.RR_Header{
			Name:   question.Name,
			Rrtype: dns.TypeCNAME,
			Class:  dns.ClassINET,
			Ttl:    ttl,
		},
		Target: target + ".",
	}
	resp.Answer = []dns.RR{cname}
	return resp
}

func (r *Resolver) blockedReply(req *dns.Msg, question dns.Question) *dns.Msg {
	r.responseMu.RLock()
	blockedResponse := r.blockedResponse
	blockedTTL := r.blockedTTL
	r.responseMu.RUnlock()

	resp := new(dns.Msg)
	resp.SetReply(req)
	resp.Authoritative = true

	if blockedResponse == "nxdomain" {
		resp.Rcode = dns.RcodeNameError
		ttl := uint32(blockedTTL.Seconds())
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

	ip := net.ParseIP(blockedResponse)
	if ip == nil {
		resp.Rcode = dns.RcodeNameError
		return resp
	}
	ttl := uint32(blockedTTL.Seconds())
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

func clampTTL(ttl, minTTL, maxTTL time.Duration, respectSourceTTL bool) time.Duration {
	if ttl <= 0 {
		return ttl
	}
	if !respectSourceTTL && minTTL > 0 && ttl < minTTL {
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

func (r *Resolver) logRequest(w dns.ResponseWriter, question dns.Question, outcome string, response *dns.Msg, duration time.Duration, upstreamAddr string) {
	r.logRequestWithBreakdown(w, question, outcome, response, duration, 0, 0, upstreamAddr)
}

func (r *Resolver) fireErrorWebhook(w dns.ResponseWriter, question dns.Question, outcome string, upstreamAddr string, errMsg string, duration time.Duration) {
	if len(r.webhookOnError) == 0 {
		return
	}
	clientAddr := ""
	if w != nil {
		if addr := w.RemoteAddr(); addr != nil {
			clientAddr = addr.String()
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
	payload := webhook.OnErrorPayload{
		QName:           qname,
		ClientIP:        clientAddr,
		Timestamp:       time.Now().UTC().Format(time.RFC3339),
		Outcome:         outcome,
		UpstreamAddress: upstreamAddr,
		QType:           qtype,
		DurationMs:      duration.Seconds() * 1000.0,
		ErrorMessage:    errMsg,
	}
	for _, n := range r.webhookOnError {
		n.FireOnError(payload)
	}
}

func (r *Resolver) logRequestWithBreakdown(w dns.ResponseWriter, question dns.Question, outcome string, response *dns.Msg, duration time.Duration, cacheLookup time.Duration, networkWrite time.Duration, upstreamAddr string) {
	// Extract client info before goroutine (w may not be safe after handler returns)
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
	// Run logging async to avoid blocking the handler after WriteMsg.
	// At high QPS, request log writes and query store can delay the next request.
	go r.logRequestData(clientAddr, protocol, question, outcome, response, duration, cacheLookup, networkWrite, upstreamAddr)
}

func (r *Resolver) logRequestData(clientAddr string, protocol string, question dns.Question, outcome string, response *dns.Msg, duration time.Duration, cacheLookup time.Duration, networkWrite time.Duration, upstreamAddr string) {
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
	now := time.Now().UTC()
	clientIP := anonymize.IP(clientAddr, r.anonymizeClientIP)

	if r.requestLogWriter != nil {
		queryID := generateQueryID()
		r.requestLogWriter.Write(requestlog.Entry{
			QueryID:         queryID,
			Timestamp:       requestlog.FormatTimestamp(now),
			ClientIP:        clientIP,
			Protocol:        protocol,
			QName:           qname,
			QType:           qtype,
			QClass:          qclass,
			Outcome:         outcome,
			RCode:           rcode,
			DurationMS:      durationMS,
			CacheLookupMS:   cacheLookupMS,
			NetworkWriteMS:  networkWriteMS,
			UpstreamAddress: upstreamAddr,
		})
	}
	if r.queryStore != nil && (r.queryStoreSampleRate >= 1.0 || rand.Float64() < r.queryStoreSampleRate) {
		clientName := ""
		if r.clientIDEnabled && r.clientIDResolver != nil {
			resolved := r.clientIDResolver.Resolve(clientAddr)
			if resolved != "" && resolved != clientAddr {
				clientName = resolved
			}
		}
		r.queryStore.Record(querystore.Event{
			Timestamp:       now,
			ClientIP:        clientIP,
			ClientName:      clientName,
			Protocol:        protocol,
			QName:           qname,
			QType:           qtype,
			QClass:          qclass,
			Outcome:         outcome,
			RCode:           rcode,
			DurationMS:      durationMS,
			CacheLookupMS:   cacheLookupMS,
			NetworkWriteMS:  networkWriteMS,
			UpstreamAddress: upstreamAddr,
		})
	}
}

func generateQueryID() string {
	b := make([]byte, 6)
	if _, err := crand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
