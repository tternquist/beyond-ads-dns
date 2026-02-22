package control

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/pprof"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"golang.org/x/time/rate"
	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/dnsresolver"
	"github.com/tternquist/beyond-ads-dns/internal/errorlog"
	"github.com/tternquist/beyond-ads-dns/internal/localrecords"
	"github.com/tternquist/beyond-ads-dns/internal/metrics"
	"github.com/tternquist/beyond-ads-dns/internal/sync"
	"github.com/tternquist/beyond-ads-dns/internal/tracelog"
)

// Config holds dependencies for the control server.
type Config struct {
	ControlCfg   config.ControlConfig
	ConfigPath   string
	Blocklist    *blocklist.Manager
	LocalRecords *localrecords.Manager
	Resolver     *dnsresolver.Resolver
	Logger       *slog.Logger
	ErrorBuffer  *errorlog.ErrorBuffer
	TraceEvents  *tracelog.Events
}

// Start creates and starts the control HTTP server. Returns nil if control is disabled.
func Start(cfg Config) *http.Server {
	if cfg.ControlCfg.Enabled == nil || !*cfg.ControlCfg.Enabled {
		return nil
	}
	if cfg.ControlCfg.Listen == "" {
		if cfg.Logger != nil {
			cfg.Logger.Info("control server disabled: missing listen address")
		}
		return nil
	}
	token := strings.TrimSpace(cfg.ControlCfg.Token)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/errors", handleErrors(cfg.ErrorBuffer, token))
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	mux.Handle("/metrics", handleMetrics(cfg.Resolver))
	mux.HandleFunc("/blocklists/reload", rateLimitHandler(handleBlocklistsReload(cfg.Blocklist, cfg.Resolver, cfg.ConfigPath, token), rate.Every(10*time.Second), 1))
	mux.HandleFunc("/blocklists/stats", handleBlocklistsStats(cfg.Blocklist, token))
	mux.HandleFunc("/blocklists/health", handleBlocklistsHealth(cfg.Blocklist, token))
	mux.HandleFunc("/cache/refresh/stats", handleCacheRefreshStats(cfg.Resolver, token))
	mux.HandleFunc("/cache/stats", handleCacheStats(cfg.Resolver, token))
	mux.HandleFunc("/cache/clear", rateLimitHandler(handleCacheClear(cfg.Resolver, token), rate.Every(30*time.Second), 2))
	mux.HandleFunc("/querystore/stats", handleQuerystoreStats(cfg.Resolver, token))
	mux.HandleFunc("/blocklists/pause", rateLimitHandler(handleBlocklistsPause(cfg.Blocklist, token), rate.Every(5*time.Second), 2))
	mux.HandleFunc("/blocklists/resume", rateLimitHandler(handleBlocklistsResume(cfg.Blocklist, token), rate.Every(5*time.Second), 2))
	mux.HandleFunc("/blocked/check", handleBlockedCheck(cfg.Blocklist, token))
	mux.HandleFunc("/blocklists/pause/status", handleBlocklistsPauseStatus(cfg.Blocklist, token))
	mux.HandleFunc("/local-records/reload", rateLimitHandler(handleLocalRecordsReload(cfg.LocalRecords, cfg.ConfigPath, token), rate.Every(10*time.Second), 2))
	mux.HandleFunc("/upstreams", handleUpstreams(cfg.Resolver, token))
	mux.HandleFunc("/upstreams/reload", rateLimitHandler(handleUpstreamsReload(cfg.Resolver, cfg.ConfigPath, token), rate.Every(10*time.Second), 2))
	mux.HandleFunc("/response/reload", rateLimitHandler(handleResponseReload(cfg.Resolver, cfg.ConfigPath, token), rate.Every(10*time.Second), 2))
	mux.HandleFunc("/safe-search/reload", rateLimitHandler(handleSafeSearchReload(cfg.Resolver, cfg.ConfigPath, token), rate.Every(10*time.Second), 2))
	mux.HandleFunc("/client-identification/reload", rateLimitHandler(handleClientIdentificationReload(cfg.Resolver, cfg.ConfigPath, token), rate.Every(10*time.Second), 2))
	mux.HandleFunc("/clients", handleClientsCRUD(cfg.Resolver, cfg.ConfigPath, token))
	mux.HandleFunc("/clients/", handleClientsDeleteHandler(cfg.Resolver, cfg.ConfigPath, token))
	mux.HandleFunc("/client-groups", handleClientGroupsCRUD(cfg.Resolver, cfg.ConfigPath, token))
	mux.HandleFunc("/client-groups/", handleClientGroupsDeleteHandler(cfg.Resolver, cfg.ConfigPath, token))
	mux.HandleFunc("/sync/config", handleSyncConfig(cfg.ConfigPath, cfg.ControlCfg, cfg.Logger))
	mux.HandleFunc("/sync/status", handleSyncStatus(cfg.ConfigPath, cfg.ControlCfg))
	mux.HandleFunc("/sync/stats", handleSyncStats(cfg.ConfigPath, cfg.ControlCfg))
	mux.HandleFunc("/sync/replica-stats", handleSyncReplicaStats(cfg.ConfigPath, cfg.ControlCfg, token))
	mux.HandleFunc("/trace-events", handleTraceEvents(cfg.TraceEvents, token))

	server := &http.Server{
		Addr:    cfg.ControlCfg.Listen,
		Handler: mux,
	}
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			if cfg.Logger != nil {
				cfg.Logger.Error("control server error", "err", err)
			}
		}
	}()
	if cfg.Logger != nil {
		cfg.Logger.Info("control server listening", "addr", cfg.ControlCfg.Listen)
	}
	return server
}

// rateLimitHandler wraps h with a rate limiter. Allows burst requests, refills at refill interval.
func rateLimitHandler(h http.HandlerFunc, refill rate.Limit, burst int) http.HandlerFunc {
	limiter := rate.NewLimiter(refill, burst)
	return func(w http.ResponseWriter, r *http.Request) {
		if !limiter.Allow() {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "rate limit exceeded"})
			return
		}
		h(w, r)
	}
}

func authorize(token string, r *http.Request) bool {
	if token == "" {
		return true
	}
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return strings.TrimSpace(auth[7:]) == token
	}
	if r.Header.Get("X-Auth-Token") == token {
		return true
	}
	return false
}

func extractSyncToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return strings.TrimSpace(auth[7:])
	}
	if t := r.Header.Get("X-Sync-Token"); t != "" {
		return strings.TrimSpace(t)
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, payload map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeJSONAny(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

type resolverStatsProvider struct {
	resolver *dnsresolver.Resolver
}

func (p *resolverStatsProvider) CacheHitRate() float64 {
	if p.resolver == nil {
		return 0
	}
	return p.resolver.CacheStats().HitRate
}

func (p *resolverStatsProvider) L0Entries() int {
	if p.resolver == nil {
		return 0
	}
	stats := p.resolver.CacheStats()
	if stats.LRU == nil {
		return 0
	}
	return stats.LRU.Entries
}

func (p *resolverStatsProvider) RefreshLastSweepCount() int {
	if p.resolver == nil {
		return 0
	}
	return p.resolver.RefreshStats().LastSweepCount
}

func (p *resolverStatsProvider) QuerystoreBufferUsed() int {
	if p.resolver == nil {
		return 0
	}
	return p.resolver.QueryStoreStats().BufferUsed
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handleErrors(errorBuffer *errorlog.ErrorBuffer, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		errors := []any{}
		if errorBuffer != nil {
			for _, e := range errorBuffer.ErrorsEntries() {
				sev := string(e.Severity)
				if sev == "" {
					sev = "error"
				}
				obj := map[string]any{"message": e.Message, "timestamp": e.Timestamp, "severity": sev}
				if docRef := errorlog.DocRefForMessage(e.Message); docRef != "" {
					obj["doc_ref"] = docRef
				}
				errors = append(errors, obj)
			}
		}
		logLevel := "warning"
		if errorBuffer != nil {
			logLevel = errorBuffer.MinLevel()
		}
		writeJSONAny(w, http.StatusOK, map[string]any{"errors": errors, "log_level": logLevel})
	}
}

func handleMetrics(resolver *dnsresolver.Resolver) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if resolver != nil {
			metrics.UpdateGauges(&resolverStatsProvider{resolver: resolver})
		}
		promhttp.HandlerFor(metrics.Registry(), promhttp.HandlerOpts{}).ServeHTTP(w, r)
	})
}

func handleBlocklistsReload(manager *blocklist.Manager, resolver *dnsresolver.Resolver, configPath, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		cfg, ok := loadConfigForReload(w, configPath)
		if !ok {
			return
		}
		if err := manager.ApplyConfig(r.Context(), cfg.Blocklists); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		if resolver != nil {
			resolver.ApplyBlocklistConfig(r.Context(), cfg)
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func handleBlocklistsStats(manager *blocklist.Manager, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		stats := manager.Stats()
		resp := map[string]any{
			"blocked": stats.Blocked,
			"allow":   stats.Allow,
			"deny":    stats.Deny,
		}
		if stats.Bloom != nil {
			resp["bloom"] = map[string]any{
				"size":               stats.Bloom.Size,
				"hash_count":         stats.Bloom.HashCount,
				"set_bits":           stats.Bloom.SetBits,
				"fill_ratio":         stats.Bloom.FillRatio,
				"estimated_elements":  stats.Bloom.EstimatedElements,
				"estimated_fpr":       stats.Bloom.EstimatedFPR,
			}
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

func handleBlocklistsHealth(manager *blocklist.Manager, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		results, err := manager.ValidateSources(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		if results == nil {
			writeJSON(w, http.StatusOK, map[string]any{"sources": []any{}, "enabled": false})
			return
		}
		list := make([]map[string]any, len(results))
		for i, res := range results {
			list[i] = map[string]any{"name": res.Name, "url": res.URL, "ok": res.OK}
			if res.Error != "" {
				list[i]["error"] = res.Error
			}
			if res.Status != 0 {
				list[i]["status"] = res.Status
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"sources": list, "enabled": true})
	}
}

func handleCacheRefreshStats(resolver *dnsresolver.Resolver, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if resolver == nil {
			writeJSON(w, http.StatusOK, map[string]any{})
			return
		}
		stats := resolver.RefreshStats()
		writeJSON(w, http.StatusOK, map[string]any{
			"last_sweep_time":          stats.LastSweepTime,
			"last_sweep_count":         stats.LastSweepCount,
			"last_sweep_removed_count": stats.LastSweepRemovedCount,
			"average_per_sweep_24h":    stats.AveragePerSweep24h,
			"std_dev_per_sweep_24h":    stats.StdDevPerSweep24h,
			"sweeps_24h":               stats.Sweeps24h,
			"refreshed_24h":            stats.Refreshed24h,
			"removed_24h":              stats.Removed24h,
			"batch_size":          stats.BatchSize,
			"stats_window_sec":     stats.StatsWindowSec,
		})
	}
}

func handleCacheStats(resolver *dnsresolver.Resolver, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if resolver == nil {
			writeJSONAny(w, http.StatusOK, map[string]any{})
			return
		}
		stats := resolver.CacheStats()
		writeJSONAny(w, http.StatusOK, stats)
	}
}

func handleCacheClear(resolver *dnsresolver.Resolver, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if resolver == nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()
		if err := resolver.ClearCache(ctx); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func handleQuerystoreStats(resolver *dnsresolver.Resolver, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if resolver == nil {
			writeJSONAny(w, http.StatusOK, map[string]any{})
			return
		}
		stats := resolver.QueryStoreStats()
		writeJSONAny(w, http.StatusOK, stats)
	}
}

func handleBlocklistsPause(manager *blocklist.Manager, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var req struct {
			Duration int `json:"duration_minutes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid request"})
			return
		}
		if req.Duration <= 0 || req.Duration > 1440 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "duration must be between 1 and 1440 minutes"})
			return
		}
		duration := time.Duration(req.Duration) * time.Minute
		manager.Pause(duration)
		status := manager.PauseStatus()
		writeJSON(w, http.StatusOK, map[string]any{
			"paused": status.Paused,
			"until":  status.Until,
		})
	}
}

func handleBlocklistsResume(manager *blocklist.Manager, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		manager.Resume()
		writeJSON(w, http.StatusOK, map[string]any{"paused": false})
	}
}

func handleBlockedCheck(manager *blocklist.Manager, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		domain := strings.TrimSpace(r.URL.Query().Get("domain"))
		if domain == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "domain parameter required"})
			return
		}
		blocked := manager.IsBlocked(domain)
		writeJSON(w, http.StatusOK, map[string]any{"blocked": blocked})
	}
}

func handleBlocklistsPauseStatus(manager *blocklist.Manager, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		status := manager.PauseStatus()
		writeJSON(w, http.StatusOK, map[string]any{
			"paused": status.Paused,
			"until":  status.Until,
		})
	}
}

func handleLocalRecordsReload(localRecords *localrecords.Manager, configPath, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		cfg, ok := loadConfigForReload(w, configPath)
		if !ok {
			return
		}
		if err := localRecords.ApplyConfig(r.Context(), cfg.LocalRecords); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func handleUpstreams(resolver *dnsresolver.Resolver, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if resolver == nil {
			writeJSON(w, http.StatusOK, map[string]any{"upstreams": []any{}, "resolver_strategy": "failover"})
			return
		}
		upstreams, strategy := resolver.UpstreamConfig()
		list := make([]map[string]any, len(upstreams))
		for i, u := range upstreams {
			list[i] = map[string]any{"name": u.Name, "address": u.Address, "protocol": u.Protocol}
		}
		writeJSON(w, http.StatusOK, map[string]any{"upstreams": list, "resolver_strategy": strategy})
	}
}

func handleUpstreamsReload(resolver *dnsresolver.Resolver, configPath, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		cfg, ok := loadConfigForReload(w, configPath)
		if !ok {
			return
		}
		if resolver != nil {
			resolver.ApplyUpstreamConfig(cfg)
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func handleResponseReload(resolver *dnsresolver.Resolver, configPath, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		cfg, ok := loadConfigForReload(w, configPath)
		if !ok {
			return
		}
		if resolver != nil {
			resolver.ApplyResponseConfig(cfg)
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func handleSafeSearchReload(resolver *dnsresolver.Resolver, configPath, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		cfg, ok := loadConfigForReload(w, configPath)
		if !ok {
			return
		}
		if resolver != nil {
			resolver.ApplySafeSearchConfig(cfg)
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func handleClientIdentificationReload(resolver *dnsresolver.Resolver, configPath, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		cfg, ok := loadConfigForReload(w, configPath)
		if !ok {
			return
		}
		if resolver != nil {
			resolver.ApplyClientIdentificationConfig(cfg)
			resolver.ApplyBlocklistConfig(r.Context(), cfg)
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func handleSyncConfig(configPath string, controlCfg config.ControlConfig, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		syncToken := extractSyncToken(r)
		if syncToken == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "sync token required (Bearer or X-Sync-Token)"})
			return
		}
		cfg, err := config.Load(configPath)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		if cfg.Sync.Enabled == nil || !*cfg.Sync.Enabled || cfg.Sync.Role != "primary" {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "sync not enabled or not primary"})
			return
		}
		if !cfg.Sync.IsSyncTokenValid(syncToken) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid sync token"})
			return
		}
		dnsCfg := cfg.DNSAffecting()
		if logger != nil {
			logger.Debug("sync: config served to replica")
		}
		writeJSONAny(w, http.StatusOK, dnsCfg)
		if err := sync.UpdateTokenLastUsed(configPath, syncToken); err != nil && logger != nil {
			logger.Error("sync: could not update token last_used", "err", err)
		}
	}
}

func handleSyncStatus(configPath string, controlCfg config.ControlConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		syncToken := extractSyncToken(r)
		if syncToken == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "sync token required (Bearer or X-Sync-Token)"})
			return
		}
		cfg, err := config.Load(configPath)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		if cfg.Sync.Enabled == nil || !*cfg.Sync.Enabled || cfg.Sync.Role != "primary" {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "sync not enabled or not primary"})
			return
		}
		if !cfg.Sync.IsSyncTokenValid(syncToken) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid sync token"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"role": "primary",
			"ok":   true,
		})
	}
}

func handleSyncStats(configPath string, controlCfg config.ControlConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		syncToken := extractSyncToken(r)
		if syncToken == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "sync token required (Bearer or X-Sync-Token)"})
			return
		}
		cfg, err := config.Load(configPath)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		if cfg.Sync.Enabled == nil || !*cfg.Sync.Enabled || cfg.Sync.Role != "primary" {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "sync not enabled or not primary"})
			return
		}
		if !cfg.Sync.IsSyncTokenValid(syncToken) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid sync token"})
			return
		}
		// Limit body size to prevent memory exhaustion from malicious replicas
		const maxSyncStatsBody = 256 * 1024 // 256KB
		r.Body = http.MaxBytesReader(w, r.Body, maxSyncStatsBody)
		var payload struct {
			Release              string         `json:"release"`
			BuildTime            string         `json:"build_time"`
			StatsSourceURL       string         `json:"stats_source_url"`
			Blocklist            map[string]any `json:"blocklist"`
			Cache                map[string]any `json:"cache"`
			CacheRefresh         map[string]any `json:"cache_refresh"`
			ResponseDistribution map[string]any `json:"response_distribution"`
			ResponseTime         map[string]any `json:"response_time"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			if err == io.EOF {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "empty body"})
				return
			}
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
			return
		}
		name := cfg.Sync.SyncTokenName(syncToken)
		sync.StoreReplicaStatsWithMeta(syncToken, name, payload.Release, payload.BuildTime, payload.StatsSourceURL, payload.Blocklist, payload.Cache, payload.CacheRefresh, payload.ResponseDistribution, payload.ResponseTime)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func handleSyncReplicaStats(configPath string, controlCfg config.ControlConfig, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		cfg, err := config.Load(configPath)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		if cfg.Sync.Enabled == nil || !*cfg.Sync.Enabled || cfg.Sync.Role != "primary" {
			writeJSON(w, http.StatusOK, map[string]any{"replicas": []any{}})
			return
		}
		replicas := sync.GetAllReplicaStats()
		writeJSONAny(w, http.StatusOK, map[string]any{"replicas": replicas})
	}
}

func handleTraceEvents(events *tracelog.Events, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if events == nil {
			writeJSON(w, http.StatusOK, map[string]any{
				"events":     []string{},
				"all_events": tracelog.AllEvents,
			})
			return
		}
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{
				"events":     events.Get(),
				"all_events": tracelog.AllEvents,
			})
		case http.MethodPut:
			var req struct {
				Events []string `json:"events"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
				return
			}
			events.Set(req.Events)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "events": events.Get(), "message": "Trace events updated. Changes apply immediately."})
		}
	}
}
