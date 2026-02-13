package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

const (
	defaultBlockedResponse = "nxdomain"
)

type Duration struct {
	time.Duration
}

func (d *Duration) UnmarshalYAML(value *yaml.Node) error {
	if value == nil || value.Kind == 0 {
		return nil
	}
	if value.Kind != yaml.ScalarNode {
		return fmt.Errorf("duration must be a scalar")
	}
	if value.Value == "" {
		return nil
	}
	if value.Tag == "!!int" {
		seconds, err := strconv.Atoi(value.Value)
		if err != nil {
			return fmt.Errorf("invalid duration integer %q: %w", value.Value, err)
		}
		d.Duration = time.Duration(seconds) * time.Second
		return nil
	}
	parsed, err := time.ParseDuration(value.Value)
	if err != nil {
		return fmt.Errorf("invalid duration %q: %w", value.Value, err)
	}
	d.Duration = parsed
	return nil
}

type Config struct {
	Server           ServerConfig     `yaml:"server"`
	Upstreams        []UpstreamConfig `yaml:"upstreams"`
	ResolverStrategy string          `yaml:"resolver_strategy"`
	Blocklists       BlocklistConfig  `yaml:"blocklists"`
	LocalRecords     []LocalRecordEntry `yaml:"local_records"`
	Cache            CacheConfig     `yaml:"cache"`
	Response         ResponseConfig  `yaml:"response"`
	RequestLog       RequestLogConfig `yaml:"request_log"`
	QueryStore            QueryStoreConfig            `yaml:"query_store"`
	ClientIdentification  ClientIdentificationConfig  `yaml:"client_identification"`
	Control               ControlConfig               `yaml:"control"`
	DoHDotServer     DoHDotServerConfig `yaml:"doh_dot_server"`
	Sync             SyncConfig      `yaml:"sync"`
	UI               UIConfig        `yaml:"ui"`
}

// SyncConfig configures multi-instance sync (primary/replica).
type SyncConfig struct {
	Role         string         `yaml:"role"` // "primary" or "replica"
	Enabled      *bool          `yaml:"enabled"`
	Tokens       []SyncToken    `yaml:"tokens"`        // primary: list of tokens for replicas
	PrimaryURL   string         `yaml:"primary_url"`   // replica: URL of primary control API
	SyncToken    string         `yaml:"sync_token"`    // replica: token to authenticate with primary
	SyncInterval Duration       `yaml:"sync_interval"` // replica: how often to pull config
}

// SyncToken represents a token for a replica to authenticate with the primary.
type SyncToken struct {
	ID        string `yaml:"id"`
	Name      string `yaml:"name"`
	CreatedAt string `yaml:"created_at"`
	LastUsed  string `yaml:"last_used"`
}

// DNSAffectingConfig is the subset of config that affects DNS resolution.
// Replicas receive this from the primary and must not modify it locally.
// Uses string for durations so YAML output is human-readable (e.g. "6h").
type DNSAffectingConfig struct {
	Upstreams        []UpstreamConfig `json:"upstreams"`
	ResolverStrategy string           `json:"resolver_strategy"`
	Blocklists       syncBlocklistConfig `json:"blocklists"`
	LocalRecords     []LocalRecordEntry `json:"local_records"`
	Response         syncResponseConfig `json:"response"`
}

type syncBlocklistConfig struct {
	RefreshInterval string            `json:"refresh_interval"`
	Sources         []BlocklistSource `json:"sources"`
	Allowlist       []string          `json:"allowlist"`
	Denylist        []string          `json:"denylist"`
}

type syncResponseConfig struct {
	Blocked    string `json:"blocked"`
	BlockedTTL string `json:"blocked_ttl"`
}

// DNSAffecting extracts the DNS-affecting config for sync to replicas.
func (c *Config) DNSAffecting() DNSAffectingConfig {
	return DNSAffectingConfig{
		Upstreams:        c.Upstreams,
		ResolverStrategy: c.ResolverStrategy,
		Blocklists: syncBlocklistConfig{
			RefreshInterval: c.Blocklists.RefreshInterval.Duration.String(),
			Sources:         c.Blocklists.Sources,
			Allowlist:       c.Blocklists.Allowlist,
			Denylist:        c.Blocklists.Denylist,
		},
		LocalRecords: c.LocalRecords,
		Response: syncResponseConfig{
			Blocked:    c.Response.Blocked,
			BlockedTTL: c.Response.BlockedTTL.Duration.String(),
		},
	}
}

// IsSyncTokenValid returns true if the given token matches a registered sync token.
func (c *SyncConfig) IsSyncTokenValid(token string) bool {
	token = strings.TrimSpace(token)
	if token == "" {
		return false
	}
	for _, t := range c.Tokens {
		if t.ID == token {
			return true
		}
	}
	return false
}

// LocalRecordEntry defines a static DNS record returned without upstream lookup.
// These records work even when the internet is down.
type LocalRecordEntry struct {
	Name  string `yaml:"name"`
	Type  string `yaml:"type"`  // A, AAAA, CNAME, etc.
	Value string `yaml:"value"` // IP address or target hostname
}

type ServerConfig struct {
	Listen       []string `yaml:"listen"`
	Protocols    []string `yaml:"protocols"`
	ReadTimeout  Duration `yaml:"read_timeout"`
	WriteTimeout Duration `yaml:"write_timeout"`
}

type UpstreamConfig struct {
	Name     string `yaml:"name"`
	Address  string `yaml:"address"`
	Protocol string `yaml:"protocol"`
}

type BlocklistConfig struct {
	RefreshInterval Duration          `yaml:"refresh_interval"`
	Sources         []BlocklistSource `yaml:"sources"`
	Allowlist       []string          `yaml:"allowlist"`
	Denylist        []string          `yaml:"denylist"`
}

type BlocklistSource struct {
	Name string `yaml:"name"`
	URL  string `yaml:"url"`
}

type CacheConfig struct {
	Redis            RedisConfig   `yaml:"redis"`
	MinTTL           Duration      `yaml:"min_ttl"`
	MaxTTL           Duration      `yaml:"max_ttl"`
	NegativeTTL      Duration      `yaml:"negative_ttl"`
	ServfailBackoff  Duration      `yaml:"servfail_backoff"`  // Duration to back off before retrying after SERVFAIL
	RespectSourceTTL *bool         `yaml:"respect_source_ttl"` // When true, don't extend TTL with min_ttl (avoid serving stale "ghost" data)
	Refresh          RefreshConfig `yaml:"refresh"`
}

type RedisConfig struct {
	Address  string `yaml:"address"`
	DB       int    `yaml:"db"`
	Password string `yaml:"password"`
	LRUSize  int    `yaml:"lru_size"`
}

type RefreshConfig struct {
	Enabled        *bool    `yaml:"enabled"`
	HitWindow      Duration `yaml:"hit_window"`
	HotThreshold   int64    `yaml:"hot_threshold"`
	MinTTL         Duration `yaml:"min_ttl"`
	HotTTL         Duration `yaml:"hot_ttl"`
	ServeStale     *bool    `yaml:"serve_stale"`
	StaleTTL       Duration `yaml:"stale_ttl"`
	LockTTL        Duration `yaml:"lock_ttl"`
	MaxInflight    int      `yaml:"max_inflight"`
	SweepInterval  Duration `yaml:"sweep_interval"`
	SweepWindow    Duration `yaml:"sweep_window"`
	BatchSize      int      `yaml:"batch_size"`
	SweepMinHits   int64    `yaml:"sweep_min_hits"`
	SweepHitWindow Duration `yaml:"sweep_hit_window"`
}

type ResponseConfig struct {
	Blocked    string   `yaml:"blocked"`
	BlockedTTL Duration `yaml:"blocked_ttl"`
}

type RequestLogConfig struct {
	Enabled        *bool  `yaml:"enabled"`
	Directory      string `yaml:"directory"`
	FilenamePrefix string `yaml:"filename_prefix"`
	// Format: "text" (default) or "json" for structured JSON logs with query_id, qname, outcome, latency, etc.
	Format string `yaml:"format"`
}

type QueryStoreConfig struct {
	Enabled       *bool    `yaml:"enabled"`
	Address       string   `yaml:"address"`
	Database      string   `yaml:"database"`
	Table         string   `yaml:"table"`
	Username      string   `yaml:"username"`
	Password      string   `yaml:"password"`
	FlushInterval Duration `yaml:"flush_interval"`
	BatchSize     int      `yaml:"batch_size"`
	RetentionDays int      `yaml:"retention_days"`
	// SampleRate: fraction of queries to record (0.0-1.0). 1.0 = record all. Use <1.0 to reduce load at scale.
	SampleRate float64 `yaml:"sample_rate"`
}

// ClientIdentificationConfig maps client IPs to friendly names for per-device analytics.
// Enables "Which device queries X?" in query analytics.
type ClientIdentificationConfig struct {
	Enabled *bool             `yaml:"enabled"`
	Clients map[string]string `yaml:"clients"` // IP -> name, e.g. "192.168.1.10": "kids-phone"
}

type ControlConfig struct {
	Enabled *bool  `yaml:"enabled"`
	Listen  string `yaml:"listen"`
	Token   string `yaml:"token"`
}

// DoHDotServerConfig enables DoH (DNS over HTTPS) and DoT (DNS over TLS) server modes.
// Requires TLS certificates. When enabled, clients can use encrypted DNS.
type DoHDotServerConfig struct {
	Enabled   *bool  `yaml:"enabled"`
	CertFile  string `yaml:"cert_file"`
	KeyFile   string `yaml:"key_file"`
	DoTListen string `yaml:"dot_listen"`  // e.g. "0.0.0.0:853"
	DoHListen string `yaml:"doh_listen"`  // e.g. "0.0.0.0:443" (HTTPS)
	DoHPath   string `yaml:"doh_path"`    // e.g. "/dns-query" (default)
}

type UIConfig struct {
	Hostname string `yaml:"hostname"`
}

func Load(overridePath string) (Config, error) {
	defaultPath := os.Getenv("DEFAULT_CONFIG_PATH")
	if strings.TrimSpace(defaultPath) == "" {
		defaultPath = "config/default.yaml"
	}
	return LoadWithFiles(defaultPath, overridePath)
}

func LoadWithFiles(defaultPath, overridePath string) (Config, error) {
	baseData, err := os.ReadFile(defaultPath)
	if err != nil {
		return Config{}, err
	}
	base, err := parseYAMLMap(baseData)
	if err != nil {
		return Config{}, fmt.Errorf("parse default config: %w", err)
	}
	overridePath = strings.TrimSpace(overridePath)
	if overridePath != "" {
		overrideData, err := os.ReadFile(overridePath)
		if err != nil {
			if !os.IsNotExist(err) {
				return Config{}, err
			}
		} else {
			override, err := parseYAMLMap(overrideData)
			if err != nil {
				return Config{}, fmt.Errorf("parse override config: %w", err)
			}
			base = mergeMaps(base, override)
		}
	}

	merged, err := yaml.Marshal(base)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := yaml.Unmarshal(merged, &cfg); err != nil {
		return Config{}, fmt.Errorf("parse merged config: %w", err)
	}
	applyDefaults(&cfg)
	normalize(&cfg)
	if err := validate(&cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func applyDefaults(cfg *Config) {
	if len(cfg.Server.Listen) == 0 {
		cfg.Server.Listen = []string{"0.0.0.0:53"}
	}
	if len(cfg.Server.Protocols) == 0 {
		cfg.Server.Protocols = []string{"udp", "tcp"}
	}
	if cfg.Blocklists.RefreshInterval.Duration == 0 {
		cfg.Blocklists.RefreshInterval.Duration = 6 * time.Hour
	}
	if cfg.Cache.MinTTL.Duration == 0 {
		cfg.Cache.MinTTL.Duration = 5 * time.Minute
	}
	if cfg.Cache.MaxTTL.Duration == 0 {
		cfg.Cache.MaxTTL.Duration = time.Hour
	}
	if cfg.Cache.NegativeTTL.Duration == 0 {
		cfg.Cache.NegativeTTL.Duration = 5 * time.Minute
	}
	if cfg.Cache.ServfailBackoff.Duration == 0 {
		cfg.Cache.ServfailBackoff.Duration = 60 * time.Second
	}
	if cfg.Cache.RespectSourceTTL == nil {
		cfg.Cache.RespectSourceTTL = boolPtr(false)
	}
	if cfg.Cache.Redis.LRUSize == 0 {
		cfg.Cache.Redis.LRUSize = 10000 // Default L0 cache size
	}
	if cfg.Cache.Refresh.Enabled == nil {
		cfg.Cache.Refresh.Enabled = boolPtr(true)
	}
	if cfg.Cache.Refresh.HitWindow.Duration == 0 {
		cfg.Cache.Refresh.HitWindow.Duration = time.Minute
	}
	if cfg.Cache.Refresh.HotThreshold == 0 {
		cfg.Cache.Refresh.HotThreshold = 20
	}
	if cfg.Cache.Refresh.MinTTL.Duration == 0 {
		cfg.Cache.Refresh.MinTTL.Duration = 30 * time.Second
	}
	if cfg.Cache.Refresh.HotTTL.Duration == 0 {
		cfg.Cache.Refresh.HotTTL.Duration = 2 * time.Minute
	}
	if cfg.Cache.Refresh.ServeStale == nil {
		cfg.Cache.Refresh.ServeStale = boolPtr(true)
	}
	if cfg.Cache.Refresh.StaleTTL.Duration == 0 {
		cfg.Cache.Refresh.StaleTTL.Duration = 5 * time.Minute
	}
	if cfg.Cache.Refresh.LockTTL.Duration == 0 {
		cfg.Cache.Refresh.LockTTL.Duration = 10 * time.Second
	}
	if cfg.Cache.Refresh.MaxInflight == 0 {
		cfg.Cache.Refresh.MaxInflight = 50
	}
	if cfg.Cache.Refresh.SweepInterval.Duration == 0 {
		cfg.Cache.Refresh.SweepInterval.Duration = 15 * time.Second
	}
	if cfg.Cache.Refresh.SweepWindow.Duration == 0 {
		cfg.Cache.Refresh.SweepWindow.Duration = 2 * time.Minute
	}
	if cfg.Cache.Refresh.BatchSize == 0 {
		cfg.Cache.Refresh.BatchSize = 200
	}
	if cfg.Cache.Refresh.SweepMinHits == 0 {
		cfg.Cache.Refresh.SweepMinHits = 1
	}
	if cfg.Cache.Refresh.SweepHitWindow.Duration == 0 {
		cfg.Cache.Refresh.SweepHitWindow.Duration = 7 * 24 * time.Hour
	}
	if cfg.Response.Blocked == "" {
		cfg.Response.Blocked = defaultBlockedResponse
	}
	if cfg.Response.BlockedTTL.Duration == 0 {
		cfg.Response.BlockedTTL.Duration = time.Hour
	}
	if cfg.RequestLog.Enabled == nil {
		cfg.RequestLog.Enabled = boolPtr(false)
	}
	if cfg.RequestLog.Directory == "" {
		cfg.RequestLog.Directory = "logs"
	}
	if cfg.RequestLog.FilenamePrefix == "" {
		cfg.RequestLog.FilenamePrefix = "dns-requests"
	}
	if cfg.QueryStore.Enabled == nil {
		cfg.QueryStore.Enabled = boolPtr(true)
	}
	if cfg.QueryStore.Address == "" {
		cfg.QueryStore.Address = "http://localhost:8123"
	}
	if cfg.QueryStore.Database == "" {
		cfg.QueryStore.Database = "beyond_ads"
	}
	if cfg.QueryStore.Table == "" {
		cfg.QueryStore.Table = "dns_queries"
	}
	if cfg.QueryStore.Username == "" {
		cfg.QueryStore.Username = "default"
	}
	if cfg.QueryStore.FlushInterval.Duration == 0 {
		cfg.QueryStore.FlushInterval.Duration = 5 * time.Second
	}
	if cfg.QueryStore.BatchSize == 0 {
		cfg.QueryStore.BatchSize = 500
	}
	if cfg.QueryStore.RetentionDays == 0 {
		cfg.QueryStore.RetentionDays = 7
	}
	if cfg.QueryStore.SampleRate <= 0 || cfg.QueryStore.SampleRate > 1 {
		cfg.QueryStore.SampleRate = 1.0
	}
	if cfg.RequestLog.Format == "" {
		cfg.RequestLog.Format = "text"
	}
	if cfg.Control.Enabled == nil {
		cfg.Control.Enabled = boolPtr(false)
	}
	if cfg.Control.Listen == "" {
		cfg.Control.Listen = "0.0.0.0:8081"
	}
	if len(cfg.Upstreams) == 0 {
		cfg.Upstreams = []UpstreamConfig{
			{Name: "cloudflare", Address: "1.1.1.1:53", Protocol: "udp"},
			{Name: "google", Address: "8.8.8.8:53", Protocol: "udp"},
			{Name: "quad9", Address: "9.9.9.9:53", Protocol: "udp"},
		}
	}
	if cfg.ResolverStrategy == "" {
		cfg.ResolverStrategy = "failover"
	}
	if cfg.Sync.Enabled == nil {
		cfg.Sync.Enabled = boolPtr(false)
	}
	if cfg.Sync.Role == "" {
		cfg.Sync.Role = "primary"
	}
	if cfg.Sync.Role == "replica" && cfg.Sync.SyncInterval.Duration == 0 {
		cfg.Sync.SyncInterval.Duration = 60 * time.Second
	}
	if cfg.DoHDotServer.Enabled == nil {
		cfg.DoHDotServer.Enabled = boolPtr(false)
	}
	if cfg.DoHDotServer.DoHPath == "" {
		cfg.DoHDotServer.DoHPath = "/dns-query"
	}
	if cfg.ClientIdentification.Enabled == nil {
		cfg.ClientIdentification.Enabled = boolPtr(false)
	}
	if cfg.ClientIdentification.Clients == nil {
		cfg.ClientIdentification.Clients = make(map[string]string)
	}
	// UI hostname is optional, will use OS hostname if not set
}

func normalize(cfg *Config) {
	cfg.ResolverStrategy = strings.ToLower(strings.TrimSpace(cfg.ResolverStrategy))
	cfg.Response.Blocked = strings.ToLower(strings.TrimSpace(cfg.Response.Blocked))
	for i := range cfg.Server.Protocols {
		cfg.Server.Protocols[i] = strings.ToLower(strings.TrimSpace(cfg.Server.Protocols[i]))
	}
	for i := range cfg.Upstreams {
		cfg.Upstreams[i].Address = strings.TrimSpace(cfg.Upstreams[i].Address)
		cfg.Upstreams[i].Name = strings.TrimSpace(cfg.Upstreams[i].Name)
		proto := strings.ToLower(strings.TrimSpace(cfg.Upstreams[i].Protocol))
		if proto == "" {
			if strings.HasPrefix(cfg.Upstreams[i].Address, "tls://") {
				proto = "tls"
			} else if strings.HasPrefix(cfg.Upstreams[i].Address, "https://") {
				proto = "https"
			} else {
				proto = "udp"
			}
		}
		cfg.Upstreams[i].Protocol = proto
	}
	cfg.Cache.Redis.Address = strings.TrimSpace(cfg.Cache.Redis.Address)
	cfg.Cache.Refresh.MaxInflight = maxInt(cfg.Cache.Refresh.MaxInflight, 0)
	cfg.Cache.Refresh.BatchSize = maxInt(cfg.Cache.Refresh.BatchSize, 0)
	cfg.RequestLog.Directory = strings.TrimSpace(cfg.RequestLog.Directory)
	cfg.RequestLog.FilenamePrefix = strings.TrimSpace(cfg.RequestLog.FilenamePrefix)
	cfg.RequestLog.Format = strings.ToLower(strings.TrimSpace(cfg.RequestLog.Format))
	if cfg.RequestLog.Format != "json" && cfg.RequestLog.Format != "text" {
		cfg.RequestLog.Format = "text"
	}
	cfg.QueryStore.Address = strings.TrimSpace(cfg.QueryStore.Address)
	cfg.QueryStore.Database = strings.TrimSpace(cfg.QueryStore.Database)
	cfg.QueryStore.Table = strings.TrimSpace(cfg.QueryStore.Table)
	cfg.QueryStore.Username = strings.TrimSpace(cfg.QueryStore.Username)
	cfg.QueryStore.Password = strings.TrimSpace(cfg.QueryStore.Password)
	cfg.Control.Listen = strings.TrimSpace(cfg.Control.Listen)
	cfg.Control.Token = strings.TrimSpace(cfg.Control.Token)
	cfg.Sync.Role = strings.ToLower(strings.TrimSpace(cfg.Sync.Role))
	cfg.Sync.PrimaryURL = strings.TrimSpace(cfg.Sync.PrimaryURL)
	cfg.Sync.SyncToken = strings.TrimSpace(cfg.Sync.SyncToken)
	cfg.DoHDotServer.CertFile = strings.TrimSpace(cfg.DoHDotServer.CertFile)
	cfg.DoHDotServer.KeyFile = strings.TrimSpace(cfg.DoHDotServer.KeyFile)
	cfg.DoHDotServer.DoTListen = strings.TrimSpace(cfg.DoHDotServer.DoTListen)
	cfg.DoHDotServer.DoHListen = strings.TrimSpace(cfg.DoHDotServer.DoHListen)
	if cfg.DoHDotServer.DoHPath != "" && !strings.HasPrefix(cfg.DoHDotServer.DoHPath, "/") {
		cfg.DoHDotServer.DoHPath = "/" + cfg.DoHDotServer.DoHPath
	}
	cfg.UI.Hostname = strings.TrimSpace(cfg.UI.Hostname)
	for i := range cfg.LocalRecords {
		cfg.LocalRecords[i].Name = strings.TrimSpace(strings.ToLower(cfg.LocalRecords[i].Name))
		cfg.LocalRecords[i].Type = strings.TrimSpace(strings.ToUpper(cfg.LocalRecords[i].Type))
		cfg.LocalRecords[i].Value = strings.TrimSpace(cfg.LocalRecords[i].Value)
	}
}

func validate(cfg *Config) error {
	if len(cfg.Server.Protocols) == 0 {
		return fmt.Errorf("server.protocols must not be empty")
	}
	for _, proto := range cfg.Server.Protocols {
		if proto != "udp" && proto != "tcp" {
			return fmt.Errorf("unsupported protocol %q", proto)
		}
	}
	if len(cfg.Upstreams) == 0 {
		return fmt.Errorf("at least one upstream is required")
	}
	switch cfg.ResolverStrategy {
	case "failover", "load_balance", "weighted":
		// valid
	default:
		return fmt.Errorf("resolver_strategy must be failover, load_balance, or weighted (got %q)", cfg.ResolverStrategy)
	}
	for _, upstream := range cfg.Upstreams {
		if upstream.Address == "" {
			return fmt.Errorf("upstream address must not be empty")
		}
		// Allow tls://host:port, https://host/path, or host:port
		if strings.HasPrefix(upstream.Address, "tls://") {
			hostPort := strings.TrimPrefix(upstream.Address, "tls://")
			if _, _, err := net.SplitHostPort(hostPort); err != nil {
				return fmt.Errorf("invalid DoT upstream address %q: %w", upstream.Address, err)
			}
		} else if strings.HasPrefix(upstream.Address, "https://") {
			if _, err := url.Parse(upstream.Address); err != nil {
				return fmt.Errorf("invalid DoH upstream address %q: %w", upstream.Address, err)
			}
		} else if _, _, err := net.SplitHostPort(upstream.Address); err != nil {
			return fmt.Errorf("invalid upstream address %q: %w", upstream.Address, err)
		}
		if upstream.Protocol != "" && upstream.Protocol != "udp" && upstream.Protocol != "tcp" && upstream.Protocol != "tls" && upstream.Protocol != "https" {
			return fmt.Errorf("unsupported upstream protocol %q", upstream.Protocol)
		}
	}
	for _, source := range cfg.Blocklists.Sources {
		if strings.TrimSpace(source.URL) == "" {
			return fmt.Errorf("blocklist source url must not be empty")
		}
	}
	if cfg.Response.Blocked != defaultBlockedResponse {
		if net.ParseIP(cfg.Response.Blocked) == nil {
			return fmt.Errorf("response.blocked must be %q or an IP address", defaultBlockedResponse)
		}
	}
	if cfg.RequestLog.Enabled != nil && *cfg.RequestLog.Enabled {
		if cfg.RequestLog.Directory == "" {
			return fmt.Errorf("request_log.directory must not be empty when logging is enabled")
		}
		if cfg.RequestLog.FilenamePrefix == "" {
			return fmt.Errorf("request_log.filename_prefix must not be empty when logging is enabled")
		}
	}
	if cfg.QueryStore.Enabled != nil && *cfg.QueryStore.Enabled {
		if cfg.QueryStore.Address == "" {
			return fmt.Errorf("query_store.address must not be empty when query store is enabled")
		}
		if cfg.QueryStore.Database == "" {
			return fmt.Errorf("query_store.database must not be empty when query store is enabled")
		}
		if cfg.QueryStore.Table == "" {
			return fmt.Errorf("query_store.table must not be empty when query store is enabled")
		}
		if cfg.QueryStore.Username == "" {
			return fmt.Errorf("query_store.username must not be empty when query store is enabled")
		}
		if cfg.QueryStore.BatchSize <= 0 {
			return fmt.Errorf("query_store.batch_size must be greater than zero")
		}
		if cfg.QueryStore.RetentionDays <= 0 {
			return fmt.Errorf("query_store.retention_days must be greater than zero")
		}
	}
	if cfg.Cache.Refresh.Enabled != nil && *cfg.Cache.Refresh.Enabled {
		if cfg.Cache.Refresh.HitWindow.Duration <= 0 {
			return fmt.Errorf("cache.refresh.hit_window must be greater than zero")
		}
		if cfg.Cache.Refresh.MinTTL.Duration <= 0 {
			return fmt.Errorf("cache.refresh.min_ttl must be greater than zero")
		}
		if cfg.Cache.Refresh.HotTTL.Duration <= 0 {
			return fmt.Errorf("cache.refresh.hot_ttl must be greater than zero")
		}
		if cfg.Cache.Refresh.LockTTL.Duration <= 0 {
			return fmt.Errorf("cache.refresh.lock_ttl must be greater than zero")
		}
		if cfg.Cache.Refresh.MaxInflight <= 0 {
			return fmt.Errorf("cache.refresh.max_inflight must be greater than zero")
		}
		if cfg.Cache.Refresh.ServeStale != nil && *cfg.Cache.Refresh.ServeStale {
			if cfg.Cache.Refresh.StaleTTL.Duration <= 0 {
				return fmt.Errorf("cache.refresh.stale_ttl must be greater than zero when serve_stale is enabled")
			}
		}
		if cfg.Cache.Refresh.SweepInterval.Duration <= 0 {
			return fmt.Errorf("cache.refresh.sweep_interval must be greater than zero")
		}
		if cfg.Cache.Refresh.SweepWindow.Duration <= 0 {
			return fmt.Errorf("cache.refresh.sweep_window must be greater than zero")
		}
		if cfg.Cache.Refresh.BatchSize <= 0 {
			return fmt.Errorf("cache.refresh.batch_size must be greater than zero")
		}
		if cfg.Cache.Refresh.SweepMinHits < 0 {
			return fmt.Errorf("cache.refresh.sweep_min_hits must be zero or greater")
		}
		if cfg.Cache.Refresh.SweepHitWindow.Duration <= 0 {
			return fmt.Errorf("cache.refresh.sweep_hit_window must be greater than zero")
		}
		if cfg.Cache.Refresh.HotThreshold < 0 {
			return fmt.Errorf("cache.refresh.hot_threshold must be zero or greater")
		}
	}
	if cfg.Control.Enabled != nil && *cfg.Control.Enabled {
		if cfg.Control.Listen == "" {
			return fmt.Errorf("control.listen must not be empty when control is enabled")
		}
	}
	if cfg.DoHDotServer.Enabled != nil && *cfg.DoHDotServer.Enabled {
		if cfg.DoHDotServer.CertFile == "" || cfg.DoHDotServer.KeyFile == "" {
			return fmt.Errorf("doh_dot_server.cert_file and doh_dot_server.key_file are required when doh_dot_server.enabled is true")
		}
		if cfg.DoHDotServer.DoTListen == "" && cfg.DoHDotServer.DoHListen == "" {
			return fmt.Errorf("doh_dot_server: at least one of dot_listen or doh_listen must be set")
		}
		if cfg.DoHDotServer.DoTListen != "" {
			if _, _, err := net.SplitHostPort(cfg.DoHDotServer.DoTListen); err != nil {
				return fmt.Errorf("invalid doh_dot_server.dot_listen %q: %w", cfg.DoHDotServer.DoTListen, err)
			}
		}
		if cfg.DoHDotServer.DoHListen != "" {
			if _, _, err := net.SplitHostPort(cfg.DoHDotServer.DoHListen); err != nil {
				return fmt.Errorf("invalid doh_dot_server.doh_listen %q: %w", cfg.DoHDotServer.DoHListen, err)
			}
		}
	}
	for i, rec := range cfg.LocalRecords {
		if rec.Name == "" {
			return fmt.Errorf("local_records[%d].name must not be empty", i)
		}
		if rec.Type == "" {
			return fmt.Errorf("local_records[%d].type must not be empty", i)
		}
		if rec.Value == "" {
			return fmt.Errorf("local_records[%d].value must not be empty", i)
		}
		switch rec.Type {
		case "A", "AAAA", "CNAME", "TXT", "PTR":
			// Supported types
		default:
			return fmt.Errorf("local_records[%d].type %q is not supported (use A, AAAA, CNAME, TXT, or PTR)", i, rec.Type)
		}
	}
	if cfg.Sync.Enabled != nil && *cfg.Sync.Enabled {
		if cfg.Sync.Role != "primary" && cfg.Sync.Role != "replica" {
			return fmt.Errorf("sync.role must be primary or replica (got %q)", cfg.Sync.Role)
		}
		if cfg.Sync.Role == "replica" {
			if cfg.Sync.PrimaryURL == "" {
				return fmt.Errorf("sync.primary_url must be set when sync is enabled as replica")
			}
			if cfg.Sync.SyncToken == "" {
				return fmt.Errorf("sync.sync_token must be set when sync is enabled as replica")
			}
			if cfg.Sync.SyncInterval.Duration <= 0 {
				return fmt.Errorf("sync.sync_interval must be greater than zero")
			}
		}
	}
	return nil
}

func boolPtr(value bool) *bool {
	return &value
}

func maxInt(value, min int) int {
	if value < min {
		return min
	}
	return value
}

func parseYAMLMap(data []byte) (map[string]interface{}, error) {
	var raw map[string]interface{}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	normalized, ok := normalizeMap(raw).(map[string]interface{})
	if !ok {
		return map[string]interface{}{}, nil
	}
	return normalized, nil
}

func normalizeMap(value interface{}) interface{} {
	switch typed := value.(type) {
	case map[string]interface{}:
		out := make(map[string]interface{}, len(typed))
		for key, val := range typed {
			out[key] = normalizeMap(val)
		}
		return out
	case map[interface{}]interface{}:
		out := make(map[string]interface{}, len(typed))
		for key, val := range typed {
			keyStr, ok := key.(string)
			if !ok {
				continue
			}
			out[keyStr] = normalizeMap(val)
		}
		return out
	case []interface{}:
		out := make([]interface{}, 0, len(typed))
		for _, val := range typed {
			out = append(out, normalizeMap(val))
		}
		return out
	default:
		return typed
	}
}

func mergeMaps(base, override map[string]interface{}) map[string]interface{} {
	if base == nil {
		base = map[string]interface{}{}
	}
	for key, overrideVal := range override {
		if baseVal, ok := base[key]; ok {
			baseMap, baseOK := baseVal.(map[string]interface{})
			overrideMap, overrideOK := overrideVal.(map[string]interface{})
			if baseOK && overrideOK {
				base[key] = mergeMaps(baseMap, overrideMap)
				continue
			}
		}
		base[key] = overrideVal
	}
	return base
}
