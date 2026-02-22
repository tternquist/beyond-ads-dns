package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/dnsresolver"
	"github.com/tternquist/beyond-ads-dns/internal/localrecords"
)

// readBuildInfo reads release tag and build timestamp from files next to the executable.
func readBuildInfo() (release, buildTime string) {
	exe, err := os.Executable()
	if err != nil {
		return "", ""
	}
	dir := filepath.Dir(exe)
	for _, pair := range []struct {
		path *string
		file string
	}{
		{&release, "release-tag.txt"},
		{&buildTime, "build-timestamp.txt"},
	} {
		b, err := os.ReadFile(filepath.Join(dir, pair.file))
		if err == nil && len(b) > 0 {
			*pair.path = strings.TrimSpace(string(b))
		}
	}
	return release, buildTime
}

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
	logger          *slog.Logger
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
	Logger          *slog.Logger
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
		c.logger.Error("sync: initial pull error (will retry)", "err", err)
	}
	c.pushStats(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C():
			if err := c.sync(ctx); err != nil {
				c.logger.Error("sync: pull error (will retry)", "err", err)
			}
			c.pushStats(ctx)
		}
	}
}

func (c *Client) sync(ctx context.Context) error {
	c.logger.Debug("sync: pulling config from primary")
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
			c.logger.Error("sync: blocklist reload error", "err", err)
		}
	}
	if c.localRecords != nil {
		if err := c.localRecords.ApplyConfig(ctx, fullCfg.LocalRecords); err != nil {
			c.logger.Error("sync: local records reload error", "err", err)
		}
	}
	if c.resolver != nil {
		c.resolver.ApplyUpstreamConfig(fullCfg)
		c.resolver.ApplyResponseConfig(fullCfg)
		c.resolver.ApplySafeSearchConfig(fullCfg)
		c.resolver.ApplyClientIdentificationConfig(fullCfg)
		c.resolver.ApplyBlocklistConfig(ctx, fullCfg)
	}

	c.logger.Debug("sync: config applied successfully")
	return nil
}

// pushStats sends blocklist, cache, and refresh stats to the primary as a heartbeat.
func (c *Client) pushStats(ctx context.Context) {
	// Reload stats_source_url from config so UI changes take effect without restart
	if override, err := config.ReadOverrideMap(c.configPath); err == nil {
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
		cacheRefresh["last_sweep_removed_count"] = refreshStats.LastSweepRemovedCount
		cacheRefresh["average_per_sweep_24h"] = refreshStats.AveragePerSweep24h
		cacheRefresh["std_dev_per_sweep_24h"] = refreshStats.StdDevPerSweep24h
		cacheRefresh["sweeps_24h"] = refreshStats.Sweeps24h
		cacheRefresh["refreshed_24h"] = refreshStats.Refreshed24h
		cacheRefresh["removed_24h"] = refreshStats.Removed24h
		cacheRefresh["batch_size"] = refreshStats.BatchSize
		cacheRefresh["stats_window_sec"] = refreshStats.StatsWindowSec
	}
	release, buildTime := readBuildInfo()
	payload := map[string]any{
		"blocklist":     blocklist,
		"cache":         cache,
		"cache_refresh": cacheRefresh,
	}
	if release != "" {
		payload["release"] = release
	}
	if buildTime != "" {
		payload["build_time"] = buildTime
	}
	if c.statsSourceURL != "" {
		payload["stats_source_url"] = c.statsSourceURL
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
		c.logger.Error("sync: stats marshal error", "err", err)
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.primaryURL+"/sync/stats", strings.NewReader(string(body)))
	if err != nil {
		c.logger.Error("sync: stats request error", "err", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.syncToken)
	req.Header.Set("X-Sync-Token", c.syncToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.logger.Error("sync: stats push error", "err", err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		c.logger.Error("sync: stats push returned non-200", "status", resp.StatusCode)
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
		c.logger.Error("sync: fetch summary error", "err", err)
		return nil, nil
	}
	defer resSummary.Body.Close()
	resLatency, err := http.DefaultClient.Do(reqLatency)
	if err != nil {
		c.logger.Error("sync: fetch latency error", "err", err)
		return nil, nil
	}
	defer resLatency.Body.Close()
	if resSummary.StatusCode != http.StatusOK || resLatency.StatusCode != http.StatusOK {
		c.logger.Error("sync: stats_source_url fetch returned non-200", "summary_status", resSummary.StatusCode, "latency_status", resLatency.StatusCode)
		return nil, nil
	}
	if err := json.NewDecoder(resSummary.Body).Decode(&summary); err != nil {
		c.logger.Error("sync: stats_source_url summary decode error", "err", err)
		return nil, nil
	}
	if err := json.NewDecoder(resLatency.Body).Decode(&latency); err != nil {
		c.logger.Error("sync: stats_source_url latency decode error", "err", err)
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
	override, err := config.ReadOverrideMap(c.configPath)
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

	// Only merge DNS-affecting config. query_store (flush intervals, retention_hours, etc.),
	// server, cache, control remain local—replicas tune them per-instance.
	override["blocklists"] = blocklists
	override["upstreams"] = payload.Upstreams
	override["resolver_strategy"] = payload.ResolverStrategy
	if payload.UpstreamTimeout != "" {
		override["upstream_timeout"] = payload.UpstreamTimeout
	}
	override["local_records"] = payload.LocalRecords
	override["response"] = response
	if len(payload.ClientGroups) > 0 {
		clientGroups := make([]map[string]any, 0, len(payload.ClientGroups))
		for _, g := range payload.ClientGroups {
			grp := map[string]any{"id": g.ID, "name": g.Name, "description": g.Description}
			if g.Blocklist != nil {
				bl := map[string]any{}
				if g.Blocklist.InheritGlobal != nil {
					bl["inherit_global"] = *g.Blocklist.InheritGlobal
				}
				if len(g.Blocklist.Sources) > 0 {
					bl["sources"] = g.Blocklist.Sources
				}
				if len(g.Blocklist.Allowlist) > 0 {
					bl["allowlist"] = g.Blocklist.Allowlist
				}
				if len(g.Blocklist.Denylist) > 0 {
					bl["denylist"] = g.Blocklist.Denylist
				}
				if g.Blocklist.ScheduledPause != nil {
					bl["scheduled_pause"] = g.Blocklist.ScheduledPause
				}
				if len(bl) > 0 {
					grp["blocklist"] = bl
				}
			}
			if g.SafeSearch != nil && (g.SafeSearch.Enabled != nil || g.SafeSearch.Google != nil || g.SafeSearch.Bing != nil) {
				ss := map[string]any{}
				if g.SafeSearch.Enabled != nil {
					ss["enabled"] = *g.SafeSearch.Enabled
				}
				if g.SafeSearch.Google != nil {
					ss["google"] = *g.SafeSearch.Google
				}
				if g.SafeSearch.Bing != nil {
					ss["bing"] = *g.SafeSearch.Bing
				}
				if len(ss) > 0 {
					grp["safe_search"] = ss
				}
			}
			clientGroups = append(clientGroups, grp)
		}
		override["client_groups"] = clientGroups
	}
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

	return config.WriteOverrideMap(c.configPath, override)
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
