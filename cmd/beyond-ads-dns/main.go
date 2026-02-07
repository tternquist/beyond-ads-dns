package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/miekg/dns"
	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/cache"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/dnsresolver"
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

	resolver := dnsresolver.New(cfg, cacheClient, blocklistManager, logger, requestLogger)

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
}
