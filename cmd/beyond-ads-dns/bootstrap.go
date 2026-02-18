package main

import (
	"context"
	"crypto/tls"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/miekg/dns"
	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/cache"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/control"
	"github.com/tternquist/beyond-ads-dns/internal/dnsresolver"
	"github.com/tternquist/beyond-ads-dns/internal/dohdot"
	"github.com/tternquist/beyond-ads-dns/internal/errorlog"
	"github.com/tternquist/beyond-ads-dns/internal/localrecords"
	"github.com/tternquist/beyond-ads-dns/internal/metrics"
	"github.com/tternquist/beyond-ads-dns/internal/querystore"
	"github.com/tternquist/beyond-ads-dns/internal/requestlog"
	"github.com/tternquist/beyond-ads-dns/internal/sync"
	"github.com/tternquist/beyond-ads-dns/internal/webhook"
)

// runServer loads config, wires components, starts all servers, and blocks until shutdown.
func runServer(configPath string) error {
	metrics.Init()

	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}

	// Error buffer and logger
	var persistenceCfg *errorlog.PersistenceConfig
	logLevel := "warning"
	if cfg.Control.Errors != nil && (cfg.Control.Errors.Enabled == nil || *cfg.Control.Errors.Enabled) {
		persistenceCfg = &errorlog.PersistenceConfig{
			RetentionDays:  cfg.Control.Errors.RetentionDays,
			Directory:      cfg.Control.Errors.Directory,
			FilenamePrefix: cfg.Control.Errors.FilenamePrefix,
		}
		if cfg.Control.Errors.LogLevel != "" {
			logLevel = cfg.Control.Errors.LogLevel
		}
	}
	errorBuffer := errorlog.NewBuffer(os.Stdout, 100, logLevel, nil, persistenceCfg)
	logger := log.New(errorBuffer, "beyond-ads-dns ", log.LstdFlags)
	defer func() { _ = errorBuffer.Close() }()

	// Wire error webhook
	if cfg.Webhooks.OnError != nil && cfg.Webhooks.OnError.Enabled != nil && *cfg.Webhooks.OnError.Enabled {
		webhookTarget := func(target, format string) string {
			if strings.TrimSpace(target) != "" {
				return target
			}
			return format
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
		var errorNotifiers []*webhook.Notifier
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
		if len(errorNotifiers) > 0 {
			errorBuffer.SetOnErrorAdded(func(message string) {
				payload := webhook.OnErrorPayload{
					QName:           "-",
					ClientIP:        "-",
					Outcome:         "application_error",
					UpstreamAddress: "",
					QType:           "-",
					ErrorMessage:    message,
				}
				for _, n := range errorNotifiers {
					n.FireOnError(payload)
				}
			})
		}
	}

	// Request log
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
		requestLogCloser = func() { _ = writer.Close() }
	}
	if requestLogCloser != nil {
		defer requestLogCloser()
	}

	// Query store
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
			defer func() { _ = store.Close() }()
		}
	}

	cacheClient, err := cache.NewRedisCache(cfg.Cache.Redis, logger)
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

	controlServer := control.Start(control.Config{
		ControlCfg:   cfg.Control,
		ConfigPath:   configPath,
		Blocklist:    blocklistManager,
		LocalRecords: localRecordsManager,
		Resolver:     resolver,
		Logger:       logger,
		ErrorBuffer:  errorBuffer,
	})

	// DoH/DoT
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
		dohDoHListen = "0.0.0.0:8443"
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

	// Sync client (replica)
	if cfg.Sync.Enabled != nil && *cfg.Sync.Enabled && cfg.Sync.Role == "replica" {
		defaultPath := os.Getenv("DEFAULT_CONFIG_PATH")
		if strings.TrimSpace(defaultPath) == "" {
			defaultPath = "config/default.yaml"
		}
		syncClient := sync.NewClient(sync.ClientConfig{
			PrimaryURL:     cfg.Sync.PrimaryURL,
			SyncToken:      cfg.Sync.SyncToken,
			Interval:       cfg.Sync.SyncInterval,
			StatsSourceURL: cfg.Sync.StatsSourceURL,
			ConfigPath:     configPath,
			DefaultPath:    defaultPath,
			Blocklist:      blocklistManager,
			LocalRecords:   localRecordsManager,
			Resolver:       resolver,
			Logger:         logger,
		})
		go syncClient.Run(ctx)
	}

	// DNS servers
	servers := make([]*dns.Server, 0)
	reusePort := cfg.Server.ReusePort != nil && *cfg.Server.ReusePort
	nListeners := 1
	if reusePort {
		nListeners = cfg.Server.ReusePortListeners
	}
	for _, listen := range cfg.Server.Listen {
		for _, proto := range cfg.Server.Protocols {
			for i := 0; i < nListeners; i++ {
				server := &dns.Server{
					Addr:         listen,
					Net:          proto,
					Handler:      resolver,
					ReadTimeout:  cfg.Server.ReadTimeout.Duration,
					WriteTimeout: cfg.Server.WriteTimeout.Duration,
					ReusePort:    reusePort,
				}
				servers = append(servers, server)
			}
		}
	}

	errCh := make(chan error, len(servers))
	seenAddr := make(map[string]bool)
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
		key := srv.Addr + " " + srv.Net
		if !seenAddr[key] {
			seenAddr[key] = true
			if srv.ReusePort {
				logger.Printf("listening on %s (%s) with %d SO_REUSEPORT listeners", srv.Addr, srv.Net, nListeners)
			} else {
				logger.Printf("listening on %s (%s)", srv.Addr, srv.Net)
			}
		}
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

	return nil
}
