package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/http/pprof"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/miekg/dns"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/cache"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/dnsresolver"
	"github.com/tternquist/beyond-ads-dns/internal/dohdot"
	"github.com/tternquist/beyond-ads-dns/internal/localrecords"
	"github.com/tternquist/beyond-ads-dns/internal/metrics"
	"github.com/tternquist/beyond-ads-dns/internal/querystore"
	"github.com/tternquist/beyond-ads-dns/internal/requestlog"
	"github.com/tternquist/beyond-ads-dns/internal/sync"
	"golang.org/x/crypto/bcrypt"
)

func main() {
	metrics.Init()

	// Handle set-admin-password subcommand (must run before flag.Parse)
	if len(os.Args) >= 2 && os.Args[1] == "set-admin-password" {
		if err := runSetAdminPassword(os.Args[2:]); err != nil {
			log.Fatalf("set-admin-password: %v", err)
		}
		os.Exit(0)
	}

	defaultConfig := os.Getenv("CONFIG_PATH")
	if defaultConfig == "" {
		defaultConfig = "config/config.yaml"
	}
	configPath := flag.String("config", defaultConfig, "Path to YAML config")
	flag.Parse()

	logger := log.New(os.Stdout, "beyond-ads-dns ", log.LstdFlags)

	cfg, err := config.Load(*configPath)
	if err != nil {
		logger.Fatalf("failed to load config: %v", err)
	}

	var requestLogWriter requestlog.Writer
	var requestLogCloser func()
	if cfg.RequestLog.Enabled != nil && *cfg.RequestLog.Enabled {
		writer, err := requestlog.NewDailyWriter(cfg.RequestLog.Directory, cfg.RequestLog.FilenamePrefix)
		if err != nil {
			logger.Fatalf("failed to initialize request log: %v", err)
		}
		format := "text"
		if cfg.RequestLog.Format == "json" {
			format = "json"
		}
		requestLogWriter = requestlog.NewWriter(writer, format)
		requestLogCloser = func() {
			_ = writer.Close()
		}
	}
	if requestLogCloser != nil {
		defer requestLogCloser()
	}

	var queryStore querystore.Store
	if cfg.QueryStore.Enabled != nil && *cfg.QueryStore.Enabled {
		store, err := querystore.NewClickHouseStore(
			cfg.QueryStore.Address,
			cfg.QueryStore.Database,
			cfg.QueryStore.Table,
			cfg.QueryStore.Username,
			cfg.QueryStore.Password,
			cfg.QueryStore.FlushToStoreInterval.Duration,
			cfg.QueryStore.FlushToDiskInterval.Duration,
			cfg.QueryStore.BatchSize,
			cfg.QueryStore.RetentionDays,
			logger,
		)
		if err == nil {
			queryStore = store
			defer func() {
				_ = store.Close()
			}()
		}
		// When ClickHouse is unreachable, store is nil; no log (user would not expect it)
	}

	cacheClient, err := cache.NewRedisCache(cfg.Cache.Redis)
	if err != nil {
		logger.Fatalf("failed to connect to redis: %v", err)
	}
	defer func() {
		if cacheClient != nil {
			_ = cacheClient.Close()
		}
	}()

	blocklistManager := blocklist.NewManager(cfg.Blocklists, logger)
	localRecordsManager := localrecords.New(cfg.LocalRecords, logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	blocklistManager.Start(ctx)

	resolver := dnsresolver.New(cfg, cacheClient, localRecordsManager, blocklistManager, logger, requestLogWriter, queryStore)
	resolver.StartRefreshSweeper(ctx)

	controlServer := startControlServer(cfg.Control, *configPath, blocklistManager, localRecordsManager, resolver, logger)

	// Env overrides for DoH/DoT (useful in Docker with Let's Encrypt)
	dohEnabled := cfg.DoHDotServer.Enabled != nil && *cfg.DoHDotServer.Enabled
	if env := strings.TrimSpace(os.Getenv("DOH_DOT_ENABLED")); env == "true" || env == "1" {
		dohEnabled = true
	}
	dohCertFile := strings.TrimSpace(os.Getenv("DOH_DOT_CERT_FILE"))
	if dohCertFile == "" {
		dohCertFile = cfg.DoHDotServer.CertFile
	}
	dohKeyFile := strings.TrimSpace(os.Getenv("DOH_DOT_KEY_FILE"))
	if dohKeyFile == "" {
		dohKeyFile = cfg.DoHDotServer.KeyFile
	}
	dohDotListen := strings.TrimSpace(os.Getenv("DOH_DOT_DOT_LISTEN"))
	if dohDotListen == "" {
		dohDotListen = cfg.DoHDotServer.DoTListen
	}
	if dohDotListen == "" && dohEnabled {
		dohDotListen = "0.0.0.0:853"
	}
	dohDoHListen := strings.TrimSpace(os.Getenv("DOH_DOT_DOH_LISTEN"))
	if dohDoHListen == "" {
		dohDoHListen = cfg.DoHDotServer.DoHListen
	}
	if dohDoHListen == "" && dohEnabled {
		dohDoHListen = "0.0.0.0:8443" // 8443 to avoid conflict with Node HTTPS on 443
	}

	var dohServer *http.Server
	if dohEnabled && dohCertFile != "" && dohKeyFile != "" {
		dohPath := cfg.DoHDotServer.DoHPath
		if dohPath == "" {
			dohPath = "/dns-query"
		}
		if dohDotListen != "" {
			go func() {
				if err := dohdot.DoTServer(ctx, dohDotListen, dohCertFile, dohKeyFile, resolver, logger); err != nil && ctx.Err() == nil {
					logger.Printf("DoT server error: %v", err)
				}
			}()
		}
		if dohDoHListen != "" {
			cert, err := tls.LoadX509KeyPair(dohCertFile, dohKeyFile)
			if err != nil {
				logger.Printf("DoH server: failed to load TLS cert: %v", err)
			} else {
				dohMux := http.NewServeMux()
				dohMux.Handle(dohPath, dohdot.DoHHandler(resolver, dohPath))
				dohServer = &http.Server{
					Addr:      dohDoHListen,
					Handler:   dohMux,
					TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12},
				}
				go func() {
					if err := dohServer.ListenAndServeTLS(dohCertFile, dohKeyFile); err != nil && err != http.ErrServerClosed {
						logger.Printf("DoH server error: %v", err)
					}
				}()
				logger.Printf("DoH server listening on %s%s", dohDoHListen, dohPath)
			}
		}
	}

	// Start sync client if this instance is a replica
	if cfg.Sync.Enabled != nil && *cfg.Sync.Enabled && cfg.Sync.Role == "replica" {
		defaultPath := os.Getenv("DEFAULT_CONFIG_PATH")
		if strings.TrimSpace(defaultPath) == "" {
			defaultPath = "config/default.yaml"
		}
		syncClient := sync.NewClient(sync.ClientConfig{
			PrimaryURL:   cfg.Sync.PrimaryURL,
			SyncToken:    cfg.Sync.SyncToken,
			Interval:     cfg.Sync.SyncInterval,
			ConfigPath:   *configPath,
			DefaultPath:  defaultPath,
			Blocklist:    blocklistManager,
			LocalRecords: localRecordsManager,
			Resolver:     resolver,
			Logger:       logger,
		})
		go syncClient.Run(ctx)
	}

	servers := make([]*dns.Server, 0)
	for _, listen := range cfg.Server.Listen {
		for _, proto := range cfg.Server.Protocols {
			server := &dns.Server{
				Addr:         listen,
				Net:          proto,
				Handler:      resolver,
				ReadTimeout:  cfg.Server.ReadTimeout.Duration,
				WriteTimeout: cfg.Server.WriteTimeout.Duration,
			}
			servers = append(servers, server)
		}
	}

	errCh := make(chan error, len(servers))
	for _, server := range servers {
		srv := server
		go func() {
			if err := srv.ListenAndServe(); err != nil {
				select {
				case <-ctx.Done():
					return
				default:
					errCh <- err
				}
			}
		}()
		logger.Printf("listening on %s (%s)", srv.Addr, srv.Net)
	}

	select {
	case <-ctx.Done():
		logger.Printf("shutdown requested")
	case err := <-errCh:
		logger.Printf("server error: %v", err)
	}

	for _, server := range servers {
		_ = server.Shutdown()
	}
	if controlServer != nil {
		_ = controlServer.Shutdown(ctx)
	}
	if dohServer != nil {
		_ = dohServer.Shutdown(ctx)
	}
}

func startControlServer(cfg config.ControlConfig, configPath string, manager *blocklist.Manager, localRecords *localrecords.Manager, resolver *dnsresolver.Resolver, logger *log.Logger) *http.Server {
	if cfg.Enabled == nil || !*cfg.Enabled {
		return nil
	}
	if cfg.Listen == "" {
		logger.Printf("control server disabled: missing listen address")
		return nil
	}
	token := strings.TrimSpace(cfg.Token)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	// Expose pprof for memory/goroutine profiling (useful for leak investigation)
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	mux.Handle("/metrics", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if resolver != nil {
			metrics.UpdateGauges(&resolverStatsProvider{resolver: resolver})
		}
		promhttp.HandlerFor(metrics.Registry(), promhttp.HandlerOpts{}).ServeHTTP(w, r)
	}))
	mux.HandleFunc("/blocklists/reload", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
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
		if err := manager.ApplyConfig(r.Context(), cfg.Blocklists); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("/blocklists/stats", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		stats := manager.Stats()
		writeJSON(w, http.StatusOK, map[string]any{
			"blocked": stats.Blocked,
			"allow":   stats.Allow,
			"deny":    stats.Deny,
		})
	})
	mux.HandleFunc("/blocklists/health", func(w http.ResponseWriter, r *http.Request) {
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
	})
	mux.HandleFunc("/cache/refresh/stats", func(w http.ResponseWriter, r *http.Request) {
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
			"last_sweep_time":        stats.LastSweepTime,
			"last_sweep_count":       stats.LastSweepCount,
			"average_per_sweep_24h":  stats.AveragePerSweep24h,
			"std_dev_per_sweep_24h":  stats.StdDevPerSweep24h,
			"sweeps_24h":             stats.Sweeps24h,
			"refreshed_24h":          stats.Refreshed24h,
			"batch_size":             stats.BatchSize,
			"batch_stats_window_sec": stats.BatchStatsWindowSec,
		})
	})
	mux.HandleFunc("/cache/stats", func(w http.ResponseWriter, r *http.Request) {
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
	})
	mux.HandleFunc("/querystore/stats", func(w http.ResponseWriter, r *http.Request) {
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
	})
	mux.HandleFunc("/blocklists/pause", func(w http.ResponseWriter, r *http.Request) {
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
	})
	mux.HandleFunc("/blocklists/resume", func(w http.ResponseWriter, r *http.Request) {
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
	})
	mux.HandleFunc("/blocked/check", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		domain := strings.TrimSpace(r.URL.Query().Get("domain"))
		if domain == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "domain parameter required"})
			return
		}
		blocked := manager.IsBlocked(domain)
		writeJSON(w, http.StatusOK, map[string]any{"blocked": blocked})
	})
	mux.HandleFunc("/blocklists/pause/status", func(w http.ResponseWriter, r *http.Request) {
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
	})
	mux.HandleFunc("/local-records/reload", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
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
		if err := localRecords.ApplyConfig(r.Context(), cfg.LocalRecords); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("/upstreams", func(w http.ResponseWriter, r *http.Request) {
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
	})
	mux.HandleFunc("/upstreams/reload", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
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
		if resolver != nil {
			resolver.ApplyUpstreamConfig(cfg)
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("/response/reload", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
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
		if resolver != nil {
			resolver.ApplyResponseConfig(cfg)
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("/client-identification/reload", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
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
		if resolver != nil {
			resolver.ApplyClientIdentificationConfig(cfg)
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	// Sync API: replicas pull DNS-affecting config from primary (auth via sync tokens)
	mux.HandleFunc("/sync/config", func(w http.ResponseWriter, r *http.Request) {
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
		writeJSONAny(w, http.StatusOK, dnsCfg)
		// Update token last_used so primary UI can show when each replica last pulled
		if err := sync.UpdateTokenLastUsed(configPath, syncToken); err != nil {
			logger.Printf("sync: failed to update token last_used: %v", err)
		}
	})
	mux.HandleFunc("/sync/status", func(w http.ResponseWriter, r *http.Request) {
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
	})

	server := &http.Server{
		Addr:    cfg.Listen,
		Handler: mux,
	}
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Printf("control server error: %v", err)
		}
	}()
	logger.Printf("control server listening on %s", cfg.Listen)
	return server
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

// resolverStatsProvider implements metrics.StatsProvider using the resolver's stats
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

func runSetAdminPassword(args []string) error {
	var password string
	if len(args) >= 1 && args[0] != "" {
		password = strings.TrimSpace(args[0])
	}
	if password == "" {
		fmt.Print("Enter admin password: ")
		scanner := bufio.NewScanner(os.Stdin)
		if !scanner.Scan() {
			return fmt.Errorf("no password provided")
		}
		password = strings.TrimSpace(scanner.Text())
		if password == "" {
			return fmt.Errorf("password cannot be empty")
		}
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	path := os.Getenv("ADMIN_PASSWORD_FILE")
	if path == "" {
		path = "/app/config-overrides/.admin-password"
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create directory %s: %w", dir, err)
	}
	if err := os.WriteFile(path, hash, 0600); err != nil {
		return fmt.Errorf("write password file: %w", err)
	}
	fmt.Printf("Admin password set successfully. Password file: %s\n", path)
	return nil
}
