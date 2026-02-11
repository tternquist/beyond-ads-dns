package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
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
	"github.com/tternquist/beyond-ads-dns/internal/metrics"
	"github.com/tternquist/beyond-ads-dns/internal/querystore"
	"github.com/tternquist/beyond-ads-dns/internal/requestlog"
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

	var requestLogger *log.Logger
	var requestLogCloser func()
	if cfg.RequestLog.Enabled != nil && *cfg.RequestLog.Enabled {
		writer, err := requestlog.NewDailyWriter(cfg.RequestLog.Directory, cfg.RequestLog.FilenamePrefix)
		if err != nil {
			logger.Fatalf("failed to initialize request log: %v", err)
		}
		requestLogger = log.New(writer, "", log.LstdFlags)
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
			cfg.QueryStore.FlushInterval.Duration,
			cfg.QueryStore.BatchSize,
			cfg.QueryStore.RetentionDays,
			logger,
		)
		if err != nil {
			logger.Printf("query store disabled: %v", err)
		} else {
			queryStore = store
			defer func() {
				_ = store.Close()
			}()
		}
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

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	blocklistManager.Start(ctx)

	resolver := dnsresolver.New(cfg, cacheClient, blocklistManager, logger, requestLogger, queryStore)
	resolver.StartRefreshSweeper(ctx)

	controlServer := startControlServer(cfg.Control, *configPath, blocklistManager, resolver, logger)

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
}

func startControlServer(cfg config.ControlConfig, configPath string, manager *blocklist.Manager, resolver *dnsresolver.Resolver, logger *log.Logger) *http.Server {
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
			"last_sweep_time":       stats.LastSweepTime,
			"last_sweep_count":      stats.LastSweepCount,
			"average_per_sweep_24h": stats.AveragePerSweep24h,
			"sweeps_24h":            stats.Sweeps24h,
			"refreshed_24h":         stats.Refreshed24h,
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
