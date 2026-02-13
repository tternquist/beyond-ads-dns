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
	primaryURL   string
	syncToken    string
	interval     config.Duration
	configPath   string
	defaultPath  string
	blocklist    *blocklist.Manager
	localRecords *localrecords.Manager
	resolver     *dnsresolver.Resolver
	logger       *log.Logger
}

// ClientConfig configures the sync client.
type ClientConfig struct {
	PrimaryURL   string
	SyncToken    string
	Interval     config.Duration
	ConfigPath   string
	DefaultPath  string
	Blocklist    *blocklist.Manager
	LocalRecords *localrecords.Manager
	Resolver     *dnsresolver.Resolver
	Logger       *log.Logger
}

// NewClient creates a sync client for a replica instance.
func NewClient(cfg ClientConfig) *Client {
	return &Client{
		primaryURL:   strings.TrimSuffix(cfg.PrimaryURL, "/"),
		syncToken:    cfg.SyncToken,
		interval:     cfg.Interval,
		configPath:   cfg.ConfigPath,
		defaultPath:  cfg.DefaultPath,
		blocklist:    cfg.Blocklist,
		localRecords: cfg.LocalRecords,
		resolver:     cfg.Resolver,
		logger:       cfg.Logger,
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

	// Initial sync shortly after start
	if err := c.sync(ctx); err != nil {
		c.logger.Printf("sync: initial pull failed: %v", err)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C():
			if err := c.sync(ctx); err != nil {
				c.logger.Printf("sync: pull failed: %v", err)
			}
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
	}

	c.logger.Printf("sync: config applied successfully")
	return nil
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
	response := map[string]any{
		"blocked":     payload.Response.Blocked,
		"blocked_ttl": payload.Response.BlockedTTL,
	}

	override["blocklists"] = blocklists
	override["upstreams"] = payload.Upstreams
	override["resolver_strategy"] = payload.ResolverStrategy
	override["local_records"] = payload.LocalRecords
	override["response"] = response

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
