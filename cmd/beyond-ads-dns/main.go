package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/miekg/dns"
	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/cache"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/dnsresolver"
	"github.com/tternquist/beyond-ads-dns/internal/querystore"
	"github.com/tternquist/beyond-ads-dns/internal/requestlog"
)

func main() {
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

	controlServer := startControlServer(cfg.Control, *configPath, blocklistManager, logger)

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

func startControlServer(cfg config.ControlConfig, configPath string, manager *blocklist.Manager, logger *log.Logger) *http.Server {
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
