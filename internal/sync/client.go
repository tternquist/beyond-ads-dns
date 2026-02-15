package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/dnsresolver"
	"github.com/tternquist/beyond-ads-dns/internal/localrecords"
	"gopkg.in/yaml.v3"
)

// Client pulls DNS-affecting config from the primary and applies it locally.
type Client struct {
	primaryURL      string
	syncToken       string
	interval        config.Duration
	configPath      string
	defaultPath     string
	statsSourceURL  string
	blocklist       *blocklist.Manager
	localRecords    *localrecords.Manager
	resolver        *dnsresolver.Resolver
	logger          *log.Logger
}

// ClientConfig configures the sync client.
type ClientConfig struct {
	PrimaryURL      string
	SyncToken       string
	Interval        config.Duration
	ConfigPath      string
	DefaultPath     string
	StatsSourceURL  string // optional: URL (e.g. web server) to fetch response distribution and latency from
	Blocklist       *blocklist.Manager
	LocalRecords    *localrecords.Manager
	Resolver        *dnsresolver.Resolver
	Logger          *log.Logger
}

// NewClient creates a sync client for a replica instance.
func NewClient(cfg ClientConfig) *Client {
	return &Client{
		primaryURL:     strings.TrimSuffix(cfg.PrimaryURL, "/"),
		syncToken:      cfg.SyncToken,
		interval:       cfg.Interval,
		configPath:     cfg.ConfigPath,
		defaultPath:    cfg.DefaultPath,
		statsSourceURL: strings.TrimSuffix(cfg.StatsSourceURL, "/"),
		blocklist:      cfg.Blocklist,
		localRecords:   cfg.LocalRecords,
		resolver:       cfg.Resolver,
		logger:         cfg.Logger,
	}
}

// Run starts the sync loop. It blocks until ctx is cancelled.
func (c *Client) Run(ctx context.Context) {
	d := c.interval.Duration
	if d <= 0 {
		d = 60 * time.Second
	}
	ticker := newTicker(d)
	defer ticker.Stop()

	// Initial sync and heartbeat shortly after start
	if err := c.sync(ctx); err != nil {
		c.logger.Printf("sync: initial pull failed: %v", err)
	}
	c.pushStats(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C():
			if err := c.sync(ctx); err != nil {
				c.logger.Printf("sync: pull failed: %v", err)
			}
			c.pushStats(ctx)
		}
	}
}

func (c *Client) sync(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.primaryURL+"/sync/config", nil)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.syncToken)
	req.Header.Set("X-Sync-Token", c.syncToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("primary returned %d", resp.StatusCode)
	}

	var payload config.DNSAffectingConfig
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}

	// Merge into override and write
	if err := c.mergeAndWrite(payload); err != nil {
		return fmt.Errorf("merge and write: %w", err)
	}

	// Reload components
	fullCfg, err := config.LoadWithFiles(c.defaultPath, c.configPath)
	if err != nil {
		return fmt.Errorf("reload config: %w", err)
	}

	if c.blocklist != nil {
		if err := c.blocklist.ApplyConfig(ctx, fullCfg.Blocklists); err != nil {
			c.logger.Printf("sync: blocklist reload failed: %v", err)
		}
	}
	if c.localRecords != nil {
		if err := c.localRecords.ApplyConfig(ctx, fullCfg.LocalRecords); err != nil {
			c.logger.Printf("sync: local records reload failed: %v", err)
		}
	}
	if c.resolver != nil {
		c.resolver.ApplyUpstreamConfig(fullCfg)
		c.resolver.ApplyResponseConfig(fullCfg)
		c.resolver.ApplySafeSearchConfig(fullCfg)
	}

	c.logger.Printf("sync: config applied successfully")
	return nil
}

// pushStats sends blocklist, cache, and refresh stats to the primary as a heartbeat.
func (c *Client) pushStats(ctx context.Context) {
	// Reload stats_source_url from config so UI changes take effect without restart
	if override, err := readOverrideMap(c.configPath); err == nil {
		if syncMap, ok := override["sync"].(map[string]any); ok {
			if url, ok := syncMap["stats_source_url"].(string); ok && strings.TrimSpace(url) != "" {
				c.statsSourceURL = strings.TrimSuffix(strings.TrimSpace(url), "/")
			}
		}
	}
	if c.blocklist == nil && c.resolver == nil {
		return
	}
	blocklist := map[string]any{}
	if c.blocklist != nil {
		stats := c.blocklist.Stats()
		blocklist["blocked"] = stats.Blocked
		blocklist["allow"] = stats.Allow
		blocklist["deny"] = stats.Deny
	}
	cache := map[string]any{}
	cacheRefresh := map[string]any{}
	if c.resolver != nil {
		cacheStats := c.resolver.CacheStats()
		cache["hits"] = cacheStats.Hits
		cache["misses"] = cacheStats.Misses
		cache["hit_rate"] = cacheStats.HitRate
		if cacheStats.LRU != nil {
			cache["lru"] = map[string]any{
				"entries":     cacheStats.LRU.Entries,
				"max_entries": cacheStats.LRU.MaxEntries,
			}
		}
		cache["redis_keys"] = cacheStats.RedisKeys
		refreshStats := c.resolver.RefreshStats()
		cacheRefresh["last_sweep_time"] = refreshStats.LastSweepTime
		cacheRefresh["last_sweep_count"] = refreshStats.LastSweepCount
		cacheRefresh["average_per_sweep_24h"] = refreshStats.AveragePerSweep24h
		cacheRefresh["std_dev_per_sweep_24h"] = refreshStats.StdDevPerSweep24h
		cacheRefresh["sweeps_24h"] = refreshStats.Sweeps24h
		cacheRefresh["refreshed_24h"] = refreshStats.Refreshed24h
		cacheRefresh["batch_size"] = refreshStats.BatchSize
		cacheRefresh["batch_stats_window_sec"] = refreshStats.BatchStatsWindowSec
	}
	payload := map[string]any{
		"blocklist":     blocklist,
		"cache":         cache,
		"cache_refresh": cacheRefresh,
	}
	if c.statsSourceURL != "" {
		if dist, lat := c.fetchQueryStats(ctx); dist != nil || lat != nil {
			if dist != nil {
				payload["response_distribution"] = dist
			}
			if lat != nil {
				payload["response_time"] = lat
			}
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		c.logger.Printf("sync: stats marshal failed: %v", err)
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.primaryURL+"/sync/stats", strings.NewReader(string(body)))
	if err != nil {
		c.logger.Printf("sync: stats request failed: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.syncToken)
	req.Header.Set("X-Sync-Token", c.syncToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.logger.Printf("sync: stats push failed: %v", err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		c.logger.Printf("sync: stats push returned %d", resp.StatusCode)
		return
	}
}

// fetchQueryStats fetches response distribution and latency from stats_source_url (e.g. web server).
// Returns (responseDistribution, responseTime) or (nil, nil) on error.
func (c *Client) fetchQueryStats(ctx context.Context) (map[string]any, map[string]any) {
	base := c.statsSourceURL
	window := "60"
	var summary struct {
		Statuses []struct {
			Outcome string `json:"outcome"`
			Count   int64  `json:"count"`
		} `json:"statuses"`
		Total int64 `json:"total"`
	}
	var latency struct {
		Count int64   `json:"count"`
		AvgMs float64 `json:"avgMs"`
		P50Ms float64 `json:"p50Ms"`
		P95Ms float64 `json:"p95Ms"`
		P99Ms float64 `json:"p99Ms"`
	}
	reqSummary, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/queries/summary?window_minutes="+window, nil)
	if err != nil {
		return nil, nil
	}
	reqLatency, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/queries/latency?window_minutes="+window, nil)
	if err != nil {
		return nil, nil
	}
	resSummary, err := http.DefaultClient.Do(reqSummary)
	if err != nil {
		c.logger.Printf("sync: fetch summary failed: %v", err)
		return nil, nil
	}
	defer resSummary.Body.Close()
	resLatency, err := http.DefaultClient.Do(reqLatency)
	if err != nil {
		c.logger.Printf("sync: fetch latency failed: %v", err)
		return nil, nil
	}
	defer resLatency.Body.Close()
	if resSummary.StatusCode != http.StatusOK || resLatency.StatusCode != http.StatusOK {
		c.logger.Printf("sync: stats_source_url fetch returned summary=%d latency=%d (expected 200)", resSummary.StatusCode, resLatency.StatusCode)
		return nil, nil
	}
	if err := json.NewDecoder(resSummary.Body).Decode(&summary); err != nil {
		c.logger.Printf("sync: stats_source_url summary decode failed: %v", err)
		return nil, nil
	}
	if err := json.NewDecoder(resLatency.Body).Decode(&latency); err != nil {
		c.logger.Printf("sync: stats_source_url latency decode failed: %v", err)
		return nil, nil
	}
	dist := make(map[string]any)
	for _, s := range summary.Statuses {
		dist[s.Outcome] = s.Count
	}
	dist["total"] = summary.Total
	lat := make(map[string]any)
	if latency.Count > 0 {
		lat["count"] = latency.Count
		lat["avg_ms"] = latency.AvgMs
		lat["p50_ms"] = latency.P50Ms
		lat["p95_ms"] = latency.P95Ms
		lat["p99_ms"] = latency.P99Ms
	}
	return dist, lat
}

func (c *Client) mergeAndWrite(payload config.DNSAffectingConfig) error {
	override, err := readOverrideMap(c.configPath)
	if err != nil {
		return err
	}

	// Convert payload to map for merging (preserves YAML-friendly format)
	blocklists := map[string]any{
		"refresh_interval": payload.Blocklists.RefreshInterval,
		"sources":          payload.Blocklists.Sources,
		"allowlist":        payload.Blocklists.Allowlist,
		"denylist":         payload.Blocklists.Denylist,
	}
	if payload.Blocklists.ScheduledPause != nil {
		blocklists["scheduled_pause"] = payload.Blocklists.ScheduledPause
	}
	if payload.Blocklists.HealthCheck != nil {
		blocklists["health_check"] = payload.Blocklists.HealthCheck
	}
	response := map[string]any{
		"blocked":     payload.Response.Blocked,
		"blocked_ttl": payload.Response.BlockedTTL,
	}

	// Only merge DNS-affecting config. query_store (flush intervals, retention_days, etc.),
	// server, cache, control remain local—replicas tune them per-instance.
	override["blocklists"] = blocklists
	override["upstreams"] = payload.Upstreams
	override["resolver_strategy"] = payload.ResolverStrategy
	override["local_records"] = payload.LocalRecords
	override["response"] = response
	if payload.SafeSearch.Enabled != nil || payload.SafeSearch.Google != nil || payload.SafeSearch.Bing != nil {
		safeSearch := map[string]any{}
		if payload.SafeSearch.Enabled != nil {
			safeSearch["enabled"] = *payload.SafeSearch.Enabled
		}
		if payload.SafeSearch.Google != nil {
			safeSearch["google"] = *payload.SafeSearch.Google
		}
		if payload.SafeSearch.Bing != nil {
			safeSearch["bing"] = *payload.SafeSearch.Bing
		}
		override["safe_search"] = safeSearch
	}

	// Record last successful pull for replica sync status in UI
	var syncMap map[string]any
	switch v := override["sync"].(type) {
	case map[string]any:
		syncMap = v
	default:
		syncMap = map[string]any{}
	}
	syncMap["last_pulled_at"] = time.Now().UTC().Format(time.RFC3339)
	override["sync"] = syncMap

	// Reload stats_source_url from config so changes take effect without restart
	if url, ok := syncMap["stats_source_url"].(string); ok && strings.TrimSpace(url) != "" {
		c.statsSourceURL = strings.TrimSuffix(strings.TrimSpace(url), "/")
	}

	return writeOverrideMap(c.configPath, override)
}

func readOverrideMap(path string) (map[string]any, error) {
	if path == "" {
		return map[string]any{}, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	var m map[string]any
	if err := yaml.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse override: %w", err)
	}
	if m == nil {
		m = map[string]any{}
	}
	return m, nil
}

func writeOverrideMap(path string, m map[string]any) error {
	if path == "" {
		return fmt.Errorf("config path not set")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	data, err := yaml.Marshal(m)
	if err != nil {
		return fmt.Errorf("marshal override: %w", err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("write override: %w", err)
	}
	return nil
}

// ticker is a simple interval ticker (time.Ticker with configurable duration).
type ticker struct {
	c    chan struct{}
	stop chan struct{}
}

func newTicker(d time.Duration) *ticker {
	t := &ticker{
		c:    make(chan struct{}),
		stop: make(chan struct{}),
	}
	go func() {
		for {
			select {
			case <-t.stop:
				return
			case <-time.After(d):
				select {
				case t.c <- struct{}{}:
				case <-t.stop:
					return
				}
			}
		}
	}()
	return t
}

func (t *ticker) C() <-chan struct{} { return t.c }
func (t *ticker) Stop()              { close(t.stop) }
