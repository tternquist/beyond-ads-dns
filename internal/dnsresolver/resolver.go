package dnsresolver

import (
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/rand"
	"net"
	"net/http"
	"os"
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
	"github.com/tternquist/beyond-ads-dns/internal/tracelog"
	"github.com/tternquist/beyond-ads-dns/internal/webhook"
)

const (
	defaultUpstreamTimeout      = 10 * time.Second // fallback when config not set
	refreshStatsWindow          = 24 * time.Hour  // rolling window for refresh stats
	refreshPriorityExpiryWithin = 30 * time.Second // prioritize entries expiring within this
	refreshReconcileInterval    = 240             // run expiry index reconciliation every N sweeps (~1h at 15s)
	refreshReconcileSampleSize  = 500             // sample size for expiry index reconciliation
	// Deletion candidates: computed periodically, cached to avoid expensive Redis scans.
	deletionCandidatesLimit    = 10000 // max candidates to check; caps Redis load
	deletionCandidatesInterval = 20    // recompute every N sweeps (~5 min at 15s)
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
	cache            cache.DNSCache
	localRecords     *localrecords.Manager
	blocklist        *blocklist.Manager // global blocklist
	groupBlocklists  map[string]*blocklist.Manager
	groupBlocklistsMu sync.RWMutex
	upstreamMgr      *upstreamManager
	minTTL           time.Duration
	maxTTL           time.Duration
	negativeTTL      time.Duration
	blockedTTL       time.Duration
	blockedResponse  string
	respectSourceTTL bool
	servfail         *servfailTracker
	// refresh upstream fail: global rate limit to avoid log flooding when internet is down
	refreshUpstreamFailLogInterval time.Duration
	refreshUpstreamFailLastLog     time.Time
	refreshUpstreamFailLogMu       sync.Mutex
	udpClient        *dns.Client
	tcpClient        *dns.Client
	dohClient        *http.Client
	tlsClients       map[string]*dns.Client
	tlsClientsMu     sync.RWMutex
	doqClients       map[string]doqClient
	doqClientsMu     sync.RWMutex
	tlsConnPools     map[string]*connPool
	tlsConnPoolsMu   sync.RWMutex
	tcpConnPools     map[string]*connPool
	tcpConnPoolsMu   sync.RWMutex
	logger           *slog.Logger
	requestLogWriter requestlog.Writer
	queryStore            querystore.Store
	queryStoreSampleRate  float64
	queryStoreExclusion   *querystore.ExclusionFilter
	anonymizeClientIP     string
	clientIDResolver      *clientid.Resolver
	clientIDEnabled      atomic.Bool
	refresh                   refreshConfig
	refreshSem                chan struct{}
	refreshStats              *refreshStats
	refreshSweepsSinceReconcile       atomic.Uint32
	refreshDeletionCandidatesSweeps   atomic.Uint32
	responseMu        sync.RWMutex // protects blockedResponse, blockedTTL for hot-reload
	webhookOnBlock    []*webhook.Notifier
	webhookOnError    []*webhook.Notifier
	safeSearchMu       sync.RWMutex
	safeSearchMap      map[string]string            // global: qname (lower) -> CNAME target
	groupSafeSearchMap map[string]map[string]string // per-group override (Phase 4)
	groupNoSafeSearch  map[string]bool              // groups with SafeSearch.Enabled=false (explicit disable)
	traceEvents        atomic.Pointer[tracelog.Events] // runtime-configurable trace events
}

type refreshConfig struct {
	enabled             bool
	hitWindow           time.Duration
	hotThreshold        int64
	minTTL              time.Duration
	hotTTL              time.Duration
	serveStale          bool
	staleTTL            time.Duration
	expiredEntryTTL     time.Duration // TTL in DNS response when serving expired entries
	lockTTL             time.Duration
	maxInflight         int
	sweepInterval       time.Duration
	sweepWindow         time.Duration
	maxBatchSize        int
	sweepMinHits        int64
	sweepHitWindow      time.Duration
	hitCountSampleRate  float64
}

type refreshStats struct {
	mu                   sync.Mutex
	lastSweep            time.Time
	lastCount            int
	lastRemovedCount     int
	history              []refreshRecord
	window               time.Duration
	deletionCandidates   int
	deletionCandidatesAt time.Time
}

type refreshRecord struct {
	at     time.Time
	count  int
	removed int
}

type RefreshStats struct {
	LastSweepTime         time.Time `json:"last_sweep_time"`
	LastSweepCount        int       `json:"last_sweep_count"`
	LastSweepRemovedCount int       `json:"last_sweep_removed_count"` // entries removed for missing sweep_min_hits
	AveragePerSweep24h    float64   `json:"average_per_sweep_24h"`
	StdDevPerSweep24h     float64   `json:"std_dev_per_sweep_24h"`
	Sweeps24h             int       `json:"sweeps_24h"`
	Refreshed24h          int       `json:"refreshed_24h"`
	Removed24h            int       `json:"removed_24h"` // entries removed for missing sweep_min_hits in window
	BatchSize             int       `json:"batch_size"`  // max_batch_size from config
	StatsWindowSec        int       `json:"stats_window_sec"` // rolling window for stats (seconds, default 24h)
	// EstimatedRefreshedDaily: projected refreshed count over 24h based on observed rate.
	EstimatedRefreshedDaily int `json:"estimated_refreshed_daily"`
	// EstimatedRemovedDaily: projected removed count over 24h based on observed rate.
	EstimatedRemovedDaily int `json:"estimated_removed_daily"`
	// DeletionCandidates: entries currently below sweep_min_hits (would be deleted, not refreshed).
	// Cached; recomputed periodically. 0 when sweep_min_hits=0 (all refreshed).
	DeletionCandidates int `json:"deletion_candidates"`
}

// networkConfig holds resolved upstream/network settings from config.
type networkConfig struct {
	timeout          time.Duration
	backoff          time.Duration
	connPoolIdle     time.Duration
	connPoolValidate bool
}

// parseUpstream converts a config.UpstreamConfig to Upstream, inferring protocol from address if empty.
func parseUpstream(u config.UpstreamConfig) Upstream {
	proto := strings.ToLower(strings.TrimSpace(u.Protocol))
	if proto == "" {
		if strings.HasPrefix(u.Address, "tls://") {
			proto = "tls"
		} else if strings.HasPrefix(u.Address, "https://") {
			proto = "https"
		} else if strings.HasPrefix(u.Address, "quic://") {
			proto = "quic"
		} else {
			proto = "udp"
		}
	}
	return Upstream{Name: u.Name, Address: u.Address, Protocol: proto}
}

// parseUpstreams converts config upstreams to resolver Upstreams.
func parseUpstreams(upstreams []config.UpstreamConfig) []Upstream {
	out := make([]Upstream, 0, len(upstreams))
	for _, u := range upstreams {
		out = append(out, parseUpstream(u))
	}
	return out
}

// resolveNetworkConfig extracts timeout, backoff, and connection pool settings from config.
func resolveNetworkConfig(cfg config.Config) networkConfig {
	timeout := cfg.Network.UpstreamTimeout.Duration
	if timeout <= 0 {
		timeout = cfg.UpstreamTimeout.Duration
	}
	if timeout <= 0 {
		timeout = defaultUpstreamTimeout
	}
	backoff := time.Duration(0)
	if cfg.Network.UpstreamBackoff != nil && cfg.Network.UpstreamBackoff.Duration > 0 {
		backoff = cfg.Network.UpstreamBackoff.Duration
	} else if cfg.UpstreamBackoff != nil && cfg.UpstreamBackoff.Duration > 0 {
		backoff = cfg.UpstreamBackoff.Duration
	}
	connPoolIdle := time.Duration(0)
	if cfg.Network.UpstreamConnPoolIdleTimeout != nil {
		connPoolIdle = cfg.Network.UpstreamConnPoolIdleTimeout.Duration
	} else if cfg.UpstreamConnPoolIdleTimeout != nil {
		connPoolIdle = cfg.UpstreamConnPoolIdleTimeout.Duration
	} else {
		connPoolIdle = 30 * time.Second
	}
	connPoolValidate := false
	if cfg.Network.UpstreamConnPoolValidateBeforeReuse != nil {
		connPoolValidate = *cfg.Network.UpstreamConnPoolValidateBeforeReuse
	} else if cfg.UpstreamConnPoolValidateBeforeReuse != nil {
		connPoolValidate = *cfg.UpstreamConnPoolValidateBeforeReuse
	}
	return networkConfig{timeout: timeout, backoff: backoff, connPoolIdle: connPoolIdle, connPoolValidate: connPoolValidate}
}

func New(cfg config.Config, cacheClient cache.DNSCache, localRecordsManager *localrecords.Manager, blocklistManager *blocklist.Manager, logger *slog.Logger, requestLogWriter requestlog.Writer, queryStore querystore.Store) *Resolver {
	upstreams := parseUpstreams(cfg.Upstreams)
	netCfg := resolveNetworkConfig(cfg)
		refreshCfg := refreshConfig{
			enabled:            cfg.Cache.Refresh.Enabled != nil && *cfg.Cache.Refresh.Enabled,
			hitWindow:          cfg.Cache.Refresh.HitWindow.Duration,
			hotThreshold:       cfg.Cache.Refresh.HotThreshold,
			minTTL:             cfg.Cache.Refresh.MinTTL.Duration,
			hotTTL:             cfg.Cache.Refresh.HotTTL.Duration,
			serveStale:         cfg.Cache.Refresh.ServeStale != nil && *cfg.Cache.Refresh.ServeStale,
			staleTTL:           cfg.Cache.Refresh.StaleTTL.Duration,
			expiredEntryTTL:    cfg.Cache.Refresh.ExpiredEntryTTL.Duration,
			lockTTL:            cfg.Cache.Refresh.LockTTL.Duration,
			maxInflight:        cfg.Cache.Refresh.MaxInflight,
			sweepInterval:      cfg.Cache.Refresh.SweepInterval.Duration,
			sweepWindow:        cfg.Cache.Refresh.SweepWindow.Duration,
			maxBatchSize:       cfg.Cache.Refresh.MaxBatchSize,
			sweepMinHits:       cfg.Cache.Refresh.SweepMinHits,
			sweepHitWindow:     cfg.Cache.Refresh.SweepHitWindow.Duration,
			hitCountSampleRate: cfg.Cache.Refresh.HitCountSampleRate,
		}
	var sem chan struct{}
	if refreshCfg.enabled && refreshCfg.maxInflight > 0 {
		sem = make(chan struct{}, refreshCfg.maxInflight)
	}
	var stats *refreshStats
	if refreshCfg.enabled {
		stats = &refreshStats{window: refreshStatsWindow}
	}

	respectSourceTTL := cfg.Cache.RespectSourceTTL != nil && *cfg.Cache.RespectSourceTTL
	sfBackoff := cfg.Cache.ServfailBackoff.Duration
	if sfBackoff <= 0 {
		sfBackoff = 60 * time.Second
	}
	sfRefreshThreshold := 10 // default
	if cfg.Cache.ServfailRefreshThreshold != nil {
		sfRefreshThreshold = *cfg.Cache.ServfailRefreshThreshold
		if sfRefreshThreshold < 0 {
			sfRefreshThreshold = 0
		}
	}

	sfLogInterval := sfBackoff // default: same as backoff
	if cfg.Cache.ServfailLogInterval.Duration > 0 {
		sfLogInterval = cfg.Cache.ServfailLogInterval.Duration
	}

	refreshUpstreamFailLogInterval := 60 * time.Second // default: avoid flood when internet is down
	if cfg.Cache.RefreshUpstreamFailLogInterval.Duration > 0 {
		refreshUpstreamFailLogInterval = cfg.Cache.RefreshUpstreamFailLogInterval.Duration
	}

	strategy := strings.ToLower(strings.TrimSpace(cfg.ResolverStrategy))
	if strategy == "" {
		strategy = StrategyFailover
	}
	if strategy != StrategyFailover && strategy != StrategyLoadBalance && strategy != StrategyWeighted {
		strategy = StrategyFailover
	}

	clientIDEnabled := cfg.ClientIdentification.Enabled != nil && *cfg.ClientIdentification.Enabled
	var clientIDResolver *clientid.Resolver
	if clientIDEnabled && len(cfg.ClientIdentification.Clients) > 0 {
		clientIDResolver = clientid.New(
			cfg.ClientIdentification.Clients.ToNameMap(),
			cfg.ClientIdentification.Clients.ToGroupMap(),
		)
	}

	groupBlocklists := make(map[string]*blocklist.Manager)
	for _, g := range cfg.ClientGroups {
		if blCfg := g.GroupBlocklistToConfig(cfg.Blocklists.RefreshInterval); blCfg != nil {
			groupBlocklists[g.ID] = blocklist.NewManager(*blCfg, logger, "group_id", g.ID)
		}
	}

	r := &Resolver{
		cache:                cacheClient,
		localRecords:         localRecordsManager,
		blocklist:            blocklistManager,
		groupBlocklists:      groupBlocklists,
		upstreamMgr:         newUpstreamManager(upstreams, strategy, netCfg.timeout, netCfg.backoff, netCfg.connPoolIdle, netCfg.connPoolValidate),
		minTTL:           cfg.Cache.MinTTL.Duration,
		maxTTL:           cfg.Cache.MaxTTL.Duration,
		negativeTTL:     cfg.Cache.NegativeTTL.Duration,
		blockedTTL:      cfg.Response.BlockedTTL.Duration,
		blockedResponse: cfg.Response.Blocked,
		respectSourceTTL: respectSourceTTL,
		servfail:         newServfailTracker(sfBackoff, sfRefreshThreshold, sfLogInterval),
		refreshUpstreamFailLogInterval:     refreshUpstreamFailLogInterval,
		udpClient: &dns.Client{
			Net:     "udp",
			Timeout: netCfg.timeout,
		},
		tcpClient: &dns.Client{
			Net:     "tcp",
			Timeout: netCfg.timeout,
		},
		dohClient: &http.Client{
			Timeout: netCfg.timeout,
			Transport: &http.Transport{
				MaxIdleConns:        10,
				MaxIdleConnsPerHost: 2,
				IdleConnTimeout:     90 * time.Second,
			},
		},
		logger:              logger,
		requestLogWriter:    requestLogWriter,
		queryStore:            queryStore,
		queryStoreSampleRate:  cfg.QueryStore.SampleRate,
		queryStoreExclusion:   querystore.NewExclusionFilter(cfg.QueryStore.ExcludeDomains, cfg.QueryStore.ExcludeClients),
		anonymizeClientIP:     cfg.QueryStore.AnonymizeClientIP,
		clientIDResolver:     clientIDResolver,
		refresh:              refreshCfg,
		refreshSem:            sem,
		refreshStats:          stats,
	}
	r.clientIDEnabled.Store(clientIDEnabled)
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
	r.safeSearchMap, r.groupSafeSearchMap, r.groupNoSafeSearch = buildSafeSearchMaps(cfg)
	return r
}

func (r *Resolver) ServeDNS(w dns.ResponseWriter, req *dns.Msg) {
	start := time.Now()
	if req == nil || len(req.Question) == 0 {
		dns.HandleFailed(w, req)
		r.logRequest(w, dns.Question{}, "invalid", nil, time.Since(start), "")
		r.fireErrorWebhook(w, dns.Question{}, "invalid", "", "", time.Since(start))
		if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventQueryResolution) {
			tracelog.Trace(te, r.logger, tracelog.EventQueryResolution, "query resolution", "outcome", "invalid", "duration_ms", time.Since(start).Milliseconds())
		}
		return
	}
	question := req.Question[0]
	qname := normalizeQueryName(question.Name)
	qtypeStr := dns.TypeToString[question.Qtype]

	// Local records are checked first - they work even when internet is down
	if r.localRecords != nil {
		if response := r.localRecords.Lookup(question); response != nil {
			response.Id = req.Id
			if err := w.WriteMsg(response); err != nil {
				r.logf(slog.LevelError, "failed to write local record response", "err", err)
			}
			r.logRequest(w, question, "local", response, time.Since(start), "")
			if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventQueryResolution) {
				tracelog.Trace(te, r.logger, tracelog.EventQueryResolution, "query resolution", "outcome", "local", "qname", qname, "qtype", qtypeStr, "duration_ms", time.Since(start).Milliseconds())
			}
			return
		}
	}

	// Safe search: rewrite search engine domains to force safe search (parental controls).
	// Phase 4: per-group override when group has SafeSearch; else global.
	if question.Qtype == dns.TypeA || question.Qtype == dns.TypeAAAA {
		r.safeSearchMu.RLock()
		safeSearchMap := r.safeSearchMap
		groupSafeSearchMap := r.groupSafeSearchMap
		groupNoSafeSearch := r.groupNoSafeSearch
		r.safeSearchMu.RUnlock()
		var effectiveMap map[string]string
		if len(groupSafeSearchMap) > 0 || len(groupNoSafeSearch) > 0 {
			clientAddr := clientIPFromWriter(w)
			groupID := ""
			if r.clientIDEnabled.Load() && r.clientIDResolver != nil && clientAddr != "" {
				groupID = r.clientIDResolver.ResolveGroup(clientAddr)
			}
			if groupNoSafeSearch[groupID] {
				effectiveMap = nil
			} else if m := groupSafeSearchMap[groupID]; len(m) > 0 {
				effectiveMap = m
			} else {
				effectiveMap = safeSearchMap
			}
		} else {
			effectiveMap = safeSearchMap
		}
		if len(effectiveMap) > 0 {
			if target, ok := effectiveMap[qname]; ok {
				response := r.safeSearchReply(req, question, target)
				if response != nil {
					if err := w.WriteMsg(response); err != nil {
						r.logf(slog.LevelError, "failed to write safe search response", "err", err)
					}
					r.logRequest(w, question, "safe_search", response, time.Since(start), "")
					if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventQueryResolution) {
						tracelog.Trace(te, r.logger, tracelog.EventQueryResolution, "query resolution", "outcome", "safe_search", "qname", qname, "qtype", qtypeStr, "target", target, "duration_ms", time.Since(start).Milliseconds())
					}
					return
				}
			}
		}
	}

	// Resolve blocklist: use group-specific blocklist when client is in a group with custom blocklist; else global
	if r.isBlockedForClient(w, qname) {
		metrics.RecordBlocked()
		clientAddr := clientIPFromWriter(w)
		for _, n := range r.webhookOnBlock {
			n.FireOnBlock(qname, clientAddr)
		}
		response := r.blockedReply(req, question)
		if err := w.WriteMsg(response); err != nil {
			r.logf(slog.LevelError, "failed to write blocked response", "err", err)
		}
		r.logRequest(w, question, "blocked", response, time.Since(start), "")
		if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventQueryResolution) {
			tracelog.Trace(te, r.logger, tracelog.EventQueryResolution, "query resolution", "outcome", "blocked", "qname", qname, "qtype", qtypeStr, "duration_ms", time.Since(start).Milliseconds())
		}
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
				// When serving expired entry, set TTL in response to expiredEntryTTL so clients don't cache stale data too long
				if ttl <= 0 && staleWithin && r.refresh.expiredEntryTTL > 0 {
					setMsgTTL(cached, r.refresh.expiredEntryTTL)
				}
				writeStart := time.Now()
				if err := w.WriteMsg(cached); err != nil {
					r.logf(slog.LevelError, "failed to write cached response", "err", err)
				}
				writeDuration := time.Since(writeStart)
				
				// Capture total duration BEFORE doing async operations like hit counting
				// to avoid including Redis latency in client-facing metrics
				totalDuration := time.Since(start)
				
				outcome := "cached"
				if ttl <= 0 && staleWithin {
					outcome = "stale"
				}
				
				// Log the request with accurate timing (before slow operations).
				// Release cached msg to pool after extracting rcode (enables sync.Pool reuse).
				r.logRequestWithBreakdown(w, question, outcome, cached, totalDuration, cacheLookupDuration, writeDuration, "", func(m *dns.Msg) { r.cache.ReleaseMsg(m) })
				if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventQueryResolution) {
					tracelog.Trace(te, r.logger, tracelog.EventQueryResolution, "query resolution", "outcome", outcome, "qname", qname, "qtype", qtypeStr, "duration_ms", totalDuration.Milliseconds(), "cache_lookup_ms", cacheLookupDuration.Milliseconds())
				}
				
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
						r.logf(slog.LevelWarn, "cache hit counter failed", "err", err)
					}
					if refreshEnabled && sweepWin > 0 {
						sweepCtx, sweepCancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
						if _, err := r.cache.IncrementSweepHit(sweepCtx, key, sweepWin); err != nil {
							r.logf(slog.LevelWarn, "sweep hit counter failed", "err", err)
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
			r.logf(slog.LevelError, "cache get failed", "err", err)
		}
	}

	// Check SERVFAIL backoff: if we recently got SERVFAIL for this key, return it without hitting upstream.
	if r.servfail.backoff > 0 {
		if r.servfail.InBackoff(cacheKey) {
			if r.servfail.ShouldLog(cacheKey) {
				r.logf(slog.LevelWarn, "servfail backoff active, returning SERVFAIL without retry", "cache_key", cacheKey)
			}
			response := r.servfailReply(req)
			if err := w.WriteMsg(response); err != nil {
				r.logf(slog.LevelError, "failed to write servfail response", "err", err)
			}
			r.logRequest(w, question, "servfail_backoff", response, time.Since(start), "")
			if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventQueryResolution) {
				tracelog.Trace(te, r.logger, tracelog.EventQueryResolution, "query resolution", "outcome", "servfail_backoff", "qname", qname, "qtype", qtypeStr, "cache_key", cacheKey, "duration_ms", time.Since(start).Milliseconds())
			}
			return
		}
	}

	response, upstreamAddr, err := r.exchange(req)
	if err != nil {
		r.logf(slog.LevelError, "upstream exchange failed", "err", err)
		dns.HandleFailed(w, req)
		r.logRequest(w, question, "upstream_error", nil, time.Since(start), "")
		r.fireErrorWebhook(w, question, "upstream_error", upstreamAddr, err.Error(), time.Since(start))
		if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventQueryResolution) {
			tracelog.Trace(te, r.logger, tracelog.EventQueryResolution, "query resolution", "outcome", "upstream_error", "qname", qname, "qtype", qtypeStr, "err", err, "duration_ms", time.Since(start).Milliseconds())
		}
		return
	}

	// SERVFAIL: don't cache, record backoff, return to client
	if response.Rcode == dns.RcodeServerFailure {
		if r.servfail.backoff > 0 {
			r.servfail.RecordBackoff(cacheKey)
		}
		if err := w.WriteMsg(response); err != nil {
			r.logf(slog.LevelError, "failed to write servfail response", "err", err)
		}
		r.logRequest(w, question, "servfail", response, time.Since(start), upstreamAddr)
		if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventQueryResolution) {
			tracelog.Trace(te, r.logger, tracelog.EventQueryResolution, "query resolution", "outcome", "servfail", "qname", qname, "qtype", qtypeStr, "upstream", upstreamAddr, "duration_ms", time.Since(start).Milliseconds())
		}
		return
	}

	ttl := responseTTL(response, r.negativeTTL)
	ttl = clampTTL(ttl, r.minTTL, r.maxTTL, r.respectSourceTTL)

	// Write response to client before caching to reduce end-to-end latency.
	// Cache write (Redis HSet+ZAdd+Expire) typically adds 0.5-2ms; doing it in
	// background avoids blocking the client. The next request for this key may
	// hit Redis if the goroutine hasn't finished, but the current request wins.
	if err := w.WriteMsg(response); err != nil {
		r.logf(slog.LevelError, "failed to write upstream response", "err", err)
	}
	r.logRequest(w, question, "upstream", response, time.Since(start), upstreamAddr)
	if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventQueryResolution) {
		tracelog.Trace(te, r.logger, tracelog.EventQueryResolution, "query resolution", "outcome", "upstream", "qname", qname, "qtype", qtypeStr, "upstream", upstreamAddr, "duration_ms", time.Since(start).Milliseconds())
	}

	if r.cache != nil && ttl > 0 {
		key, resp, ttlVal := cacheKey, response, ttl
		sweepWin := r.refresh.sweepHitWindow
		refreshEnabled := r.refresh.enabled
		go func() {
			if err := r.cacheSet(context.Background(), key, resp, ttlVal); err != nil {
				r.logf(slog.LevelError, "cache set failed", "err", err)
				return
			}
			if refreshEnabled && sweepWin > 0 {
				// Count the initial miss as a sweep hit so entries created by a query
				// are kept within sweep_hit_window (queried = hit or miss).
				sweepCtx, sweepCancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
				if _, err := r.cache.IncrementSweepHit(sweepCtx, key, sweepWin); err != nil {
					r.logf(slog.LevelWarn, "sweep hit counter failed", "err", err)
				}
				sweepCancel()
			}
		}()
	}
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
	if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventRefreshUpstream) {
		tracelog.Trace(te, r.logger, tracelog.EventRefreshUpstream, "refresh upstream request", "cache_key", cacheKey, "qname", question.Name, "qtype", dns.TypeToString[question.Qtype])
	}
	response, upstreamAddr, err := r.exchange(msg)
	if err != nil {
		if r.shouldLogRefreshUpstreamFail() {
			r.logf(slog.LevelError, "refresh upstream failed", "err", err)
		}
		if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventRefreshUpstream) {
			tracelog.Trace(te, r.logger, tracelog.EventRefreshUpstream, "refresh upstream failed", "cache_key", cacheKey, "qname", question.Name, "err", err)
		}
		return
	}
	if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventRefreshUpstream) {
		tracelog.Trace(te, r.logger, tracelog.EventRefreshUpstream, "refresh upstream response", "cache_key", cacheKey, "qname", question.Name, "upstream", upstreamAddr, "rcode", response.Rcode)
	}
	// SERVFAIL: don't update cache, record backoff, keep serving stale
	if response.Rcode == dns.RcodeServerFailure {
		if r.servfail.backoff > 0 {
			r.servfail.RecordBackoff(cacheKey)
		}
		count := r.servfail.IncrementCount(cacheKey)
		if r.servfail.ShouldLog(cacheKey) {
			if r.servfail.refreshThreshold > 0 && count >= r.servfail.refreshThreshold {
				r.logf(slog.LevelDebug, "refresh got SERVFAIL, stopping retries", "cache_key", cacheKey, "count", count, "threshold", r.servfail.refreshThreshold)
			} else {
				r.logf(slog.LevelDebug, "refresh got SERVFAIL, backing off", "cache_key", cacheKey)
			}
		}
		return
	}
	r.servfail.ClearCount(cacheKey)
	ttl := responseTTL(response, r.negativeTTL)
	ttl = clampTTL(ttl, r.minTTL, r.maxTTL, r.respectSourceTTL)
	if ttl > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := r.cacheSet(ctx, cacheKey, response, ttl); err != nil {
			r.logf(slog.LevelError, "refresh cache set failed", "err", err)
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
	if r.servfail.ExceedsThreshold(cacheKey) {
		return false
	}
	// Skip refresh while in SERVFAIL backoff; retry only after backoff expires
	if r.servfail.backoff > 0 && r.servfail.InBackoff(cacheKey) {
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
			r.logf(slog.LevelError, "refresh lock failed", "err", err)
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
	// Instance-specific base offset so replicas don't all sweep at the same time
	hostname, _ := os.Hostname()
	instanceOffset := time.Duration(int64(hashString(hostname)%5000)) * time.Millisecond
	ticker := time.NewTicker(r.refresh.sweepInterval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				// Add instance offset + 0–5s random jitter to reduce alignment across replicas
				jitter := instanceOffset + time.Duration(rand.Intn(5001))*time.Millisecond
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
	// Prune expired SERVFAIL tracking entries to prevent unbounded growth
	r.servfail.PruneExpired()
	// Flush pending sweep hits before checking counts. Otherwise, cache hits
	// that were just served may still be in the batcher (up to 50ms delay),
	// causing GetSweepHitCount to return 0 and incorrectly delete active keys.
	r.cache.FlushHitBatcher()
	// Clean expired entries from L0 (in-memory LRU) cache periodically.
	// Without this, expired entries accumulate until evicted by new entries,
	// wasting memory on stale data that is never served.
	if removed := r.cache.CleanLRUCache(); removed > 0 {
		r.logf(slog.LevelDebug, "L0 cache cleanup", "removed", removed)
	}

	// Periodically reconcile expiry index: remove entries for non-existent cache keys
	if n := r.refreshSweepsSinceReconcile.Add(1); n >= refreshReconcileInterval {
		r.refreshSweepsSinceReconcile.Store(0)
		if removed, err := r.cache.ReconcileExpiryIndex(ctx, refreshReconcileSampleSize); err != nil {
			r.logf(slog.LevelWarn, "expiry index reconciliation failed", "err", err)
		} else if removed > 0 {
			r.logf(slog.LevelDebug, "expiry index reconciled", "stale_entries_removed", removed)
		}
	}

	// Periodically compute deletion candidates (entries below sweep_min_hits; cached stat for UI/API)
	if r.refreshStats != nil && r.refresh.sweepMinHits > 0 {
		if n := r.refreshDeletionCandidatesSweeps.Add(1); n >= deletionCandidatesInterval {
			r.refreshDeletionCandidatesSweeps.Store(0)
			go r.computeDeletionCandidates()
		}
	}

	until := time.Now().Add(r.refresh.sweepWindow)
	candidates, err := r.cache.ExpiryCandidates(ctx, until, r.refresh.maxBatchSize)
	if err != nil {
		r.logf(slog.LevelError, "refresh sweep failed", "err", err)
		return
	}
	// Prioritize entries expiring within 30s to reduce cache misses; shuffle within each group to spread load
	now := time.Now()
	urgentThreshold := now.Add(refreshPriorityExpiryWithin)
	var urgent, normal []cache.ExpiryCandidate
	for _, c := range candidates {
		if c.SoftExpiry.Before(urgentThreshold) {
			urgent = append(urgent, c)
		} else {
			normal = append(normal, c)
		}
	}
	rand.Shuffle(len(urgent), func(i, j int) { urgent[i], urgent[j] = urgent[j], urgent[i] })
	rand.Shuffle(len(normal), func(i, j int) { normal[i], normal[j] = normal[j], normal[i] })
	candidates = append(urgent, normal...)

	// Batch Exists + GetSweepHitCount to reduce Redis round-trips
	checks, err := r.cache.BatchCandidateChecks(ctx, candidates, r.refresh.sweepHitWindow)
	if err != nil {
		r.logf(slog.LevelError, "refresh sweep batch check failed", "err", err)
		return
	}
	refreshed := 0
	cleanedBelowThreshold := 0
	servfailSkipped := 0
	for i := 0; i < len(candidates) && i < len(checks); i++ {
		candidate := candidates[i]
		check := checks[i]
		if !check.Exists {
			r.cache.RemoveFromIndex(ctx, candidate.Key)
			continue
		}
		if r.refresh.sweepMinHits > 0 && check.SweepHits < r.refresh.sweepMinHits {
			// Cold key: delete to prevent unbounded Redis memory growth.
			r.cache.DeleteCacheKey(ctx, candidate.Key)
			cleanedBelowThreshold++
			continue
		}
		qname, qtype, qclass, ok := parseCacheKey(candidate.Key)
		if !ok {
			r.cache.RemoveFromIndex(ctx, candidate.Key)
			continue
		}
		if r.servfail.ExceedsThreshold(candidate.Key) || r.servfail.InBackoff(candidate.Key) {
			servfailSkipped++
		}
		q := dns.Question{Name: dns.Fqdn(qname), Qtype: qtype, Qclass: qclass}
		if r.scheduleRefresh(q, candidate.Key) {
			refreshed++
		}
	}
	if cleanedBelowThreshold > 0 {
		r.logf(slog.LevelDebug, "cache key cleaned up (below sweep_min_hits threshold)", "keys_removed", cleanedBelowThreshold)
	}
	if r.refreshStats != nil {
		r.refreshStats.record(refreshed, cleanedBelowThreshold)
	}
	metrics.RecordRefreshSweep(refreshed)
	if len(candidates) > 0 || refreshed > 0 || cleanedBelowThreshold > 0 || servfailSkipped > 0 {
		r.logf(slog.LevelDebug, "refresh sweep", "candidates", len(candidates), "refreshed", refreshed, "cleaned_below_threshold", cleanedBelowThreshold, "servfail_skipped", servfailSkipped)
	}
}

// computeDeletionCandidates counts entries currently below sweep_min_hits (would be
// deleted instead of refreshed). Samples from expiry index; runs in background; result is cached.
func (r *Resolver) computeDeletionCandidates() {
	if r.cache == nil || r.refreshStats == nil || r.refresh.sweepMinHits <= 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	// Use far-future until to sample entries across the cache (not just next 24h)
	until := time.Now().Add(365 * 24 * time.Hour)
	candidates, err := r.cache.ExpiryCandidates(ctx, until, deletionCandidatesLimit)
	if err != nil {
		r.logf(slog.LevelDebug, "deletion candidates compute failed", "err", err)
		return
	}
	if len(candidates) == 0 {
		r.refreshStats.updateDeletionCandidates(0)
		return
	}
	checks, err := r.cache.BatchCandidateChecks(ctx, candidates, r.refresh.sweepHitWindow)
	if err != nil {
		r.logf(slog.LevelDebug, "deletion candidates batch check failed", "err", err)
		return
	}
	count := 0
	for i := 0; i < len(candidates) && i < len(checks); i++ {
		check := checks[i]
		if check.Exists && r.refresh.sweepMinHits > 0 && check.SweepHits < r.refresh.sweepMinHits {
			count++
		}
	}
	r.refreshStats.updateDeletionCandidates(count)
}

func (r *Resolver) RefreshStats() RefreshStats {
	if r.refreshStats == nil {
		return RefreshStats{}
	}
	stats := r.refreshStats.snapshot()
	stats.BatchSize = r.refresh.maxBatchSize
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
// SetTraceEvents sets the runtime trace events. Used by bootstrap and control API.
func (r *Resolver) SetTraceEvents(events *tracelog.Events) {
	r.traceEvents.Store(events)
}

func (r *Resolver) ApplyUpstreamConfig(cfg config.Config) {
	upstreams := parseUpstreams(cfg.Upstreams)
	netCfg := resolveNetworkConfig(cfg)
	strategy := strings.ToLower(strings.TrimSpace(cfg.ResolverStrategy))
	if strategy == "" {
		strategy = StrategyFailover
	}
	if strategy != StrategyFailover && strategy != StrategyLoadBalance && strategy != StrategyWeighted {
		strategy = StrategyFailover
	}

	r.upstreamMgr.ApplyConfig(upstreams, strategy, netCfg.timeout, netCfg.backoff, netCfg.connPoolIdle, netCfg.connPoolValidate)

	// Recreate UDP/TCP clients with new timeout
	r.udpClient = &dns.Client{Net: "udp", Timeout: netCfg.timeout}
	r.tcpClient = &dns.Client{Net: "tcp", Timeout: netCfg.timeout}

	// Clear TLS client cache so new clients use the new timeout
	r.tlsClientsMu.Lock()
	r.tlsClients = nil
	r.tlsClientsMu.Unlock()

	// Clear DoQ client cache. Note: doq-go Client has no Close() method; orphaned
	// QUIC connections are released when GC collects the clients. Consider explicit
	// cleanup if the library adds Close() in the future.
	r.doqClientsMu.Lock()
	r.doqClients = nil
	r.doqClientsMu.Unlock()

	// Clear connection pools so they are recreated with new clients
	r.tlsConnPoolsMu.Lock()
	for _, p := range r.tlsConnPools {
		drainConnPool(p)
	}
	r.tlsConnPools = nil
	r.tlsConnPoolsMu.Unlock()
	r.tcpConnPoolsMu.Lock()
	for _, p := range r.tcpConnPools {
		drainConnPool(p)
	}
	r.tcpConnPools = nil
	r.tcpConnPoolsMu.Unlock()
}

// UpstreamConfig returns the current upstream configuration for API/UI display.
func (r *Resolver) UpstreamConfig() ([]Upstream, string) {
	return r.upstreamMgr.Upstreams()
}

// isBlockedForClient returns true if qname is blocked for the client making the request.
// Uses group-specific blocklist when client is in a group with custom blocklist; else global.
// Performance: when no group blocklists exist, skips client/group resolution (negligible overhead).
func (r *Resolver) isBlockedForClient(w dns.ResponseWriter, qname string) bool {
	blMgr := r.blocklist
	r.groupBlocklistsMu.RLock()
	hasGroupBlocklists := len(r.groupBlocklists) > 0
	r.groupBlocklistsMu.RUnlock()
	if !hasGroupBlocklists {
		if blMgr == nil {
			return false
		}
		return blMgr.IsBlocked(qname)
	}
	clientAddr := clientIPFromWriter(w)
	if r.clientIDEnabled.Load() && r.clientIDResolver != nil && clientAddr != "" {
		groupID := r.clientIDResolver.ResolveGroup(clientAddr)
		if groupID != "" {
			r.groupBlocklistsMu.RLock()
			grpMgr := r.groupBlocklists[groupID]
			r.groupBlocklistsMu.RUnlock()
			if grpMgr != nil {
				blMgr = grpMgr
			}
		}
	}
	if blMgr == nil {
		return false
	}
	return blMgr.IsBlocked(qname)
}

// clientIPFromWriter extracts the client IP from dns.ResponseWriter, stripping port if present.
// Returns empty string if w is nil or RemoteAddr is nil.
func clientIPFromWriter(w dns.ResponseWriter) string {
	if w == nil {
		return ""
	}
	addr := w.RemoteAddr()
	if addr == nil {
		return ""
	}
	clientAddr := addr.String()
	if host, _, err := net.SplitHostPort(clientAddr); err == nil {
		return host
	}
	return clientAddr
}

// ApplyClientIdentificationConfig updates client IP->name and IP->group mappings at runtime (for hot-reload).
func (r *Resolver) ApplyClientIdentificationConfig(cfg config.Config) {
	enabled := cfg.ClientIdentification.Enabled != nil && *cfg.ClientIdentification.Enabled
	r.clientIDEnabled.Store(enabled)
	nameMap := cfg.ClientIdentification.Clients.ToNameMap()
	groupMap := cfg.ClientIdentification.Clients.ToGroupMap()
	if r.clientIDResolver != nil {
		r.clientIDResolver.ApplyConfig(nameMap, groupMap)
	} else if enabled && len(cfg.ClientIdentification.Clients) > 0 {
		r.clientIDResolver = clientid.New(nameMap, groupMap)
	} else {
		r.clientIDResolver = nil
	}
}

// buildSafeSearchMaps builds global and per-group safe search maps from config (Phase 4).
func buildSafeSearchMaps(cfg config.Config) (global map[string]string, groupMaps map[string]map[string]string, groupDisabled map[string]bool) {
	// Global safe search
	global = buildSafeSearchMapFromConfig(cfg.SafeSearch)

	// Per-group overrides
	groupMaps = make(map[string]map[string]string)
	groupDisabled = make(map[string]bool)
	for _, g := range cfg.ClientGroups {
		if g.SafeSearch == nil {
			continue
		}
		if g.SafeSearch.Enabled != nil && !*g.SafeSearch.Enabled {
			groupDisabled[g.ID] = true
			continue
		}
		m := buildSafeSearchMapFromConfig(*g.SafeSearch)
		if len(m) > 0 {
			groupMaps[g.ID] = m
		}
	}
	return global, groupMaps, groupDisabled
}

func buildSafeSearchMapFromConfig(ss config.SafeSearchConfig) map[string]string {
	enabled := ss.Enabled != nil && *ss.Enabled
	googleSafe := ss.Google == nil || *ss.Google
	bingSafe := ss.Bing == nil || *ss.Bing
	if !enabled || (!googleSafe && !bingSafe) {
		return nil
	}
	m := make(map[string]string)
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
	return m
}

// ApplySafeSearchConfig updates safe search maps at runtime (for hot-reload and sync).
func (r *Resolver) ApplySafeSearchConfig(cfg config.Config) {
	global, groupMaps, groupDisabled := buildSafeSearchMaps(cfg)
	r.safeSearchMu.Lock()
	r.safeSearchMap = global
	r.groupSafeSearchMap = groupMaps
	r.groupNoSafeSearch = groupDisabled
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

// ApplyBlocklistConfig updates per-group blocklist managers at runtime (for hot-reload and sync).
// The global blocklist is applied by the control server; this updates group-specific managers.
func (r *Resolver) ApplyBlocklistConfig(ctx context.Context, cfg config.Config) {
	r.groupBlocklistsMu.Lock()
	defer r.groupBlocklistsMu.Unlock()

	refreshInterval := cfg.Blocklists.RefreshInterval
	next := make(map[string]*blocklist.Manager)

	for _, g := range cfg.ClientGroups {
		blCfg := g.GroupBlocklistToConfig(refreshInterval)
		if blCfg == nil {
			continue
		}
		existing := r.groupBlocklists[g.ID]
		if existing != nil {
			if err := existing.ApplyConfig(ctx, *blCfg); err != nil && r.logger != nil {
				r.logger.Error("group blocklist apply failed", "group_id", g.ID, "err", err)
			}
			next[g.ID] = existing
		} else {
			mgr := blocklist.NewManager(*blCfg, r.logger, "group_id", g.ID)
			if err := mgr.ApplyConfig(ctx, *blCfg); err != nil && r.logger != nil {
				r.logger.Error("group blocklist initial load failed", "group_id", g.ID, "err", err)
			}
			mgr.Start(ctx)
			next[g.ID] = mgr
		}
	}

	r.groupBlocklists = next
}

// StartGroupBlocklists starts background refresh for all group blocklist managers.
// Call from bootstrap after creating the resolver.
func (r *Resolver) StartGroupBlocklists(ctx context.Context) {
	r.groupBlocklistsMu.RLock()
	defer r.groupBlocklistsMu.RUnlock()
	for _, mgr := range r.groupBlocklists {
		mgr.Start(ctx)
	}
}

func (s *refreshStats) updateDeletionCandidates(count int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deletionCandidates = count
	s.deletionCandidatesAt = time.Now()
}

func (s *refreshStats) record(count, removed int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	s.lastSweep = now
	s.lastCount = count
	s.lastRemovedCount = removed
	s.history = append(s.history, refreshRecord{at: now, count: count, removed: removed})
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
	const secPerDay = 86400
	if len(s.history) == 0 {
		return RefreshStats{
			LastSweepTime:           s.lastSweep,
			LastSweepCount:          s.lastCount,
			LastSweepRemovedCount:   s.lastRemovedCount,
			AveragePerSweep24h:      0,
			StdDevPerSweep24h:       0,
			Sweeps24h:               0,
			Refreshed24h:            0,
			Removed24h:              0,
			StatsWindowSec:          windowSec,
			EstimatedRefreshedDaily: 0,
			EstimatedRemovedDaily:   0,
			DeletionCandidates:      s.deletionCandidates,
		}
	}
	total := 0
	totalRemoved := 0
	oldest := s.history[0].at
	for _, record := range s.history {
		total += record.count
		totalRemoved += record.removed
		if record.at.Before(oldest) {
			oldest = record.at
		}
	}
	elapsedSec := time.Since(oldest).Seconds()
	if elapsedSec < 1 {
		elapsedSec = 1
	}
	// Project observed rate to 24h
	scale := secPerDay / elapsedSec
	estRefreshed := int(float64(total) * scale)
	estRemoved := int(float64(totalRemoved) * scale)
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
		LastSweepTime:           s.lastSweep,
		LastSweepCount:          s.lastCount,
		LastSweepRemovedCount:   s.lastRemovedCount,
		AveragePerSweep24h:      avg,
		StdDevPerSweep24h:       stdDev,
		Sweeps24h:               len(s.history),
		Refreshed24h:            total,
		Removed24h:              totalRemoved,
		StatsWindowSec:          windowSec,
		EstimatedRefreshedDaily:  estRefreshed,
		EstimatedRemovedDaily:   estRemoved,
		DeletionCandidates:      s.deletionCandidates,
	}
}

// hashString returns a non-cryptographic hash of s for instance-specific jitter.
func hashString(s string) uint32 {
	const prime32 = 16777619
	h := uint32(2166136261)
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= prime32
	}
	return h
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


// shouldLogRefreshUpstreamFail returns true if we should log a "refresh upstream failed" error.
// When refreshUpstreamFailLogInterval > 0, logs at most once per interval globally to avoid
// flooding when internet is down (many cache keys fail with the same dial/network error).
func (r *Resolver) shouldLogRefreshUpstreamFail() bool {
	if r.refreshUpstreamFailLogInterval <= 0 {
		return true
	}
	r.refreshUpstreamFailLogMu.Lock()
	defer r.refreshUpstreamFailLogMu.Unlock()
	now := time.Now()
	if !r.refreshUpstreamFailLastLog.IsZero() && now.Sub(r.refreshUpstreamFailLastLog) < r.refreshUpstreamFailLogInterval {
		return false
	}
	r.refreshUpstreamFailLastLog = now
	return true
}


func (r *Resolver) exchange(req *dns.Msg) (*dns.Msg, string, error) {
	upstreams, _ := r.upstreamMgr.Upstreams()

	if len(upstreams) == 0 {
		return nil, "", errors.New("no upstreams configured")
	}

	qname, qtypeStr := "", ""
	if len(req.Question) > 0 {
		qname = normalizeQueryName(req.Question[0].Name)
		qtypeStr = dns.TypeToString[req.Question[0].Qtype]
	}

	order := r.upstreamMgr.Order(upstreams)
	var lastErr error
	for attempt, idx := range order {
		upstream := upstreams[idx]
		if r.upstreamMgr.IsInBackoff(upstream.Address) {
			if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventUpstreamExchange) {
				tracelog.Trace(te, r.logger, tracelog.EventUpstreamExchange, "upstream exchange skip", "upstream", upstream.Address, "reason", "backoff", "qname", qname, "qtype", qtypeStr, "attempt", attempt+1)
			}
			continue
		}
		// Copy only on retry; first attempt uses req directly to avoid allocation in majority (success) case
		var msg *dns.Msg
		if attempt == 0 {
			msg = req
		} else {
			msg = req.Copy()
		}
		response, elapsed, err := r.exchangeWithUpstream(msg, upstream)
		if err != nil {
			if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventUpstreamExchange) {
				tracelog.Trace(te, r.logger, tracelog.EventUpstreamExchange, "upstream exchange failed", "upstream", upstream.Address, "err", err, "qname", qname, "qtype", qtypeStr, "attempt", attempt+1)
			}
			if r.upstreamMgr.BackoffEnabled() {
				r.upstreamMgr.RecordBackoff(upstream.Address)
			}
			lastErr = err
			continue
		}
		if response == nil {
			continue
		}

		if r.upstreamMgr.BackoffEnabled() {
			r.upstreamMgr.ClearBackoff(upstream.Address)
		}
		// Update weighted latency EWMA on success
		if r.upstreamMgr.Strategy() == StrategyWeighted {
			r.upstreamMgr.UpdateWeightedLatency(upstream.Address, elapsed)
		}

		if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventUpstreamExchange) {
			tracelog.Trace(te, r.logger, tracelog.EventUpstreamExchange, "upstream exchange ok", "upstream", upstream.Address, "elapsed_ms", elapsed.Milliseconds(), "rcode", response.Rcode, "qname", qname, "qtype", qtypeStr, "attempt", attempt+1)
		}

		// SERVFAIL: return immediately without trying other upstreams.
		// Indicates upstream security issue or misconfiguration; retrying aggressively is unhelpful.
		if response.Rcode == dns.RcodeServerFailure {
			return response, upstream.Address, nil
		}
		if response.Truncated && upstream.Protocol != "tcp" && upstream.Protocol != "tls" && upstream.Protocol != "https" && upstream.Protocol != "quic" {
			tcpResponse, _, tcpErr := r.tcpClient.Exchange(msg, upstream.Address)
			if tcpErr == nil && tcpResponse != nil {
				return tcpResponse, upstream.Address, nil
			}
			if te := r.traceEvents.Load(); te != nil && te.Enabled(tracelog.EventUpstreamExchange) {
				tracelog.Trace(te, r.logger, tracelog.EventUpstreamExchange, "upstream exchange failed", "upstream", upstream.Address, "err", tcpErr, "qname", qname, "qtype", qtypeStr, "attempt", attempt+1, "phase", "tcp_fallback")
			}
			if r.upstreamMgr.BackoffEnabled() {
				r.upstreamMgr.RecordBackoff(upstream.Address)
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

// setMsgTTL sets the TTL on all RRs in Answer, Ns, and Extra to the given duration.
// Used when serving expired entries so clients receive a short TTL instead of the original.
func setMsgTTL(msg *dns.Msg, ttl time.Duration) {
	if msg == nil || ttl <= 0 {
		return
	}
	ttlSec := uint32(ttl.Seconds())
	if ttlSec == 0 {
		ttlSec = 1 // minimum 1 second
	}
	for _, rr := range msg.Answer {
		rr.Header().Ttl = ttlSec
	}
	for _, rr := range msg.Ns {
		rr.Header().Ttl = ttlSec
	}
	for _, rr := range msg.Extra {
		rr.Header().Ttl = ttlSec
	}
}

func cacheKey(name string, qtype, qclass uint16) string {
	return fmt.Sprintf("dns:%s:%d:%d", name, qtype, qclass)
}

func normalizeQueryName(name string) string {
	trimmed := strings.TrimSpace(strings.TrimSuffix(name, "."))
	return strings.ToLower(trimmed)
}

func (r *Resolver) logf(level slog.Level, msg string, args ...any) {
	if r.logger == nil {
		return
	}
	r.logger.Log(nil, level, msg, args...)
}

func (r *Resolver) logRequest(w dns.ResponseWriter, question dns.Question, outcome string, response *dns.Msg, duration time.Duration, upstreamAddr string) {
	r.logRequestWithBreakdown(w, question, outcome, response, duration, 0, 0, upstreamAddr, nil)
}

func (r *Resolver) fireErrorWebhook(w dns.ResponseWriter, question dns.Question, outcome string, upstreamAddr string, errMsg string, duration time.Duration) {
	if len(r.webhookOnError) == 0 {
		return
	}
	clientAddr := clientIPFromWriter(w)
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

// logRequestWithBreakdown runs logging async. If releaseMsg is non-nil, it is called
// with response after extracting rcode, enabling early release of pooled messages.
func (r *Resolver) logRequestWithBreakdown(w dns.ResponseWriter, question dns.Question, outcome string, response *dns.Msg, duration time.Duration, cacheLookup time.Duration, networkWrite time.Duration, upstreamAddr string, releaseMsg func(*dns.Msg)) {
	// Extract client info and rcode before goroutine (w may not be safe after handler returns)
	clientAddr := clientIPFromWriter(w)
	protocol := ""
	if w != nil {
		if addr := w.RemoteAddr(); addr != nil {
			protocol = addr.Network()
		}
	}
	rcode := "-"
	if response != nil {
		rcode = dns.RcodeToString[response.Rcode]
		if rcode == "" {
			rcode = fmt.Sprintf("%d", response.Rcode)
		}
	}
	if releaseMsg != nil {
		releaseMsg(response)
	}
	// Run logging async to avoid blocking the handler after WriteMsg.
	go r.logRequestData(clientAddr, protocol, question, outcome, rcode, duration, cacheLookup, networkWrite, upstreamAddr)
}

func (r *Resolver) logRequestData(clientAddr string, protocol string, question dns.Question, outcome string, rcode string, duration time.Duration, cacheLookup time.Duration, networkWrite time.Duration, upstreamAddr string) {
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
		if r.clientIDEnabled.Load() && r.clientIDResolver != nil {
			resolved := r.clientIDResolver.Resolve(clientAddr)
			if resolved != "" && resolved != clientAddr {
				clientName = resolved
			}
		}
		if r.queryStoreExclusion != nil && r.queryStoreExclusion.Excluded(qname, clientAddr, clientName) {
			return
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
