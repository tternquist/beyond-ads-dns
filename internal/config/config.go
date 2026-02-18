package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"runtime"
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
	UpstreamTimeout  Duration        `yaml:"upstream_timeout"`  // Timeout for UDP/TCP/TLS upstream queries (default: 10s)
	UpstreamBackoff  *Duration       `yaml:"upstream_backoff"`  // Duration to skip an upstream after connection/timeout failure (omit = 30s, "0" = disabled)
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
	Webhooks         WebhooksConfig  `yaml:"webhooks"`
	SafeSearch       SafeSearchConfig `yaml:"safe_search"`
}

// SyncConfig configures multi-instance sync (primary/replica).
type SyncConfig struct {
	Role            string      `yaml:"role"`              // "primary" or "replica"
	Enabled         *bool       `yaml:"enabled"`
	Tokens          []SyncToken `yaml:"tokens"`             // primary: list of tokens for replicas
	PrimaryURL      string      `yaml:"primary_url"`       // replica: URL of primary control API
	SyncToken       string      `yaml:"sync_token"`        // replica: token to authenticate with primary
	SyncInterval    Duration    `yaml:"sync_interval"`      // replica: how often to pull config
	StatsSourceURL  string      `yaml:"stats_source_url"`  // replica: optional URL (e.g. web server) to fetch response distribution and latency from
}

// SyncToken represents a token for a replica to authenticate with the primary.
type SyncToken struct {
	ID        string `yaml:"id"`
	Name      string `yaml:"name"`
	CreatedAt string `yaml:"created_at"`
	LastUsed  string `yaml:"last_used"`
}

// syncSafeSearchConfig is the sync payload for safe search.
type syncSafeSearchConfig struct {
	Enabled *bool `json:"enabled,omitempty"`
	Google  *bool `json:"google,omitempty"`
	Bing    *bool `json:"bing,omitempty"`
}

// DNSAffectingConfig is the subset of config that affects DNS resolution.
// Replicas receive this from the primary and must not modify it locally.
// Uses string for durations so YAML output is human-readable (e.g. "6h").
type DNSAffectingConfig struct {
	Upstreams        []UpstreamConfig     `json:"upstreams"`
	ResolverStrategy string               `json:"resolver_strategy"`
	UpstreamTimeout  string               `json:"upstream_timeout,omitempty"`
	Blocklists       syncBlocklistConfig  `json:"blocklists"`
	LocalRecords     []LocalRecordEntry   `json:"local_records"`
	Response         syncResponseConfig   `json:"response"`
	SafeSearch       syncSafeSearchConfig `json:"safe_search,omitempty"`
}

type syncBlocklistConfig struct {
	RefreshInterval string                        `json:"refresh_interval"`
	Sources         []BlocklistSource            `json:"sources"`
	Allowlist       []string                      `json:"allowlist"`
	Denylist        []string                      `json:"denylist"`
	ScheduledPause  *ScheduledPauseConfig         `json:"scheduled_pause,omitempty"`
	HealthCheck     *BlocklistHealthCheckConfig   `json:"health_check,omitempty"`
}

type syncResponseConfig struct {
	Blocked    string `json:"blocked"`
	BlockedTTL string `json:"blocked_ttl"`
}

// DNSAffecting extracts the DNS-affecting config for sync to replicas.
// System settings (server, cache, query_store including flush intervals, control, etc.) are
// intentionally excluded so replicas can tune them locally (e.g. query store flush interval).
func (c *Config) DNSAffecting() DNSAffectingConfig {
	timeoutStr := c.UpstreamTimeout.Duration.String()
	if timeoutStr == "0s" {
		timeoutStr = "10s"
	}
	return DNSAffectingConfig{
		Upstreams:        c.Upstreams,
		ResolverStrategy: c.ResolverStrategy,
		UpstreamTimeout:  timeoutStr,
		Blocklists: syncBlocklistConfig{
			RefreshInterval: c.Blocklists.RefreshInterval.Duration.String(),
			Sources:         c.Blocklists.Sources,
			Allowlist:       c.Blocklists.Allowlist,
			Denylist:        c.Blocklists.Denylist,
			ScheduledPause:  c.Blocklists.ScheduledPause,
			HealthCheck:    c.Blocklists.HealthCheck,
		},
		LocalRecords: c.LocalRecords,
		Response: syncResponseConfig{
			Blocked:    c.Response.Blocked,
			BlockedTTL: c.Response.BlockedTTL.Duration.String(),
		},
		SafeSearch: syncSafeSearchConfig{
			Enabled: c.SafeSearch.Enabled,
			Google:  c.SafeSearch.Google,
			Bing:    c.SafeSearch.Bing,
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

// SyncTokenName returns the human-readable name for the given token ID, or "" if not found.
func (c *SyncConfig) SyncTokenName(tokenID string) string {
	tokenID = strings.TrimSpace(tokenID)
	for _, t := range c.Tokens {
		if t.ID == tokenID {
			if t.Name != "" {
				return t.Name
			}
			return "Replica"
		}
	}
	return ""
}

// LocalRecordEntry defines a static DNS record returned without upstream lookup.
// These records work even when the internet is down.
type LocalRecordEntry struct {
	Name  string `yaml:"name"`
	Type  string `yaml:"type"`  // A, AAAA, CNAME, etc.
	Value string `yaml:"value"` // IP address or target hostname
}

type ServerConfig struct {
	Listen             []string `yaml:"listen"`
	Protocols          []string `yaml:"protocols"`
	ReadTimeout        Duration `yaml:"read_timeout"`
	WriteTimeout       Duration `yaml:"write_timeout"`
	ReusePort          *bool    `yaml:"reuse_port"`           // SO_REUSEPORT: multiple listeners on same port for UDP/TCP
	ReusePortListeners int      `yaml:"reuse_port_listeners"` // Number of listeners per address when reuse_port is true (default: 4)
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
	// ScheduledPause pauses blocking during specific hours (e.g. work hours).
	ScheduledPause *ScheduledPauseConfig `yaml:"scheduled_pause"`
	// HealthCheck validates blocklist URLs before apply; blocks apply if any fail.
	HealthCheck *BlocklistHealthCheckConfig `yaml:"health_check"`
}

// ScheduledPauseConfig defines when blocking is automatically paused.
// When current time falls within a window, blocking is paused (allow work tools during day).
type ScheduledPauseConfig struct {
	Enabled *bool  `yaml:"enabled"`
	Start   string `yaml:"start"`   // HH:MM (24h), e.g. "09:00"
	End     string `yaml:"end"`     // HH:MM (24h), e.g. "17:00"
	Days    []int  `yaml:"days"`   // 0=Sun, 1=Mon, ..., 6=Sat. Empty = all days.
}

// BlocklistHealthCheckConfig validates blocklist URLs before apply.
type BlocklistHealthCheckConfig struct {
	Enabled    *bool `yaml:"enabled"`
	FailOnAny  *bool `yaml:"fail_on_any"`  // If true, apply fails when any source fails. If false, log and continue.
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
	ServfailBackoff           Duration      `yaml:"servfail_backoff"`            // Duration to back off before retrying after SERVFAIL
	ServfailRefreshThreshold  *int          `yaml:"servfail_refresh_threshold"`  // Stop retrying refresh after this many SERVFAILs (0 or nil = no limit)
	ServfailLogInterval       Duration      `yaml:"servfail_log_interval"`      // Min interval between logging servfail messages per cache key (0 = no limit, default: servfail_backoff)
	RespectSourceTTL *bool         `yaml:"respect_source_ttl"` // When true, don't extend TTL with min_ttl (avoid serving stale "ghost" data)
	Refresh          RefreshConfig `yaml:"refresh"`
}

type RedisConfig struct {
	Address  string `yaml:"address"`
	DB       int    `yaml:"db"`
	Password string `yaml:"password"`
	LRUSize  int    `yaml:"lru_size"`
	// Mode: "standalone" (default), "sentinel", or "cluster"
	Mode string `yaml:"mode"`
	// Sentinel: used when mode=sentinel
	MasterName     string   `yaml:"master_name"`
	SentinelAddrs  []string  `yaml:"sentinel_addrs"`
	// Cluster: used when mode=cluster. Comma-separated or list of addresses.
	ClusterAddrs   []string  `yaml:"cluster_addrs"`
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
	BatchSize      int      `yaml:"batch_size"`      // deprecated, use MaxBatchSize
	MaxBatchSize      int       `yaml:"max_batch_size"`
	SweepMinHits      int64     `yaml:"sweep_min_hits"`
	SweepHitWindow    Duration  `yaml:"sweep_hit_window"`
	BatchStatsWindow  Duration  `yaml:"batch_stats_window"` // window for dynamic batch size stats (default 2h)
	// HitCountSampleRate: fraction of cache hits to count in Redis (0.01-1.0). 1.0 = count all. Use <1.0 to reduce Redis load at high QPS.
	HitCountSampleRate float64 `yaml:"hit_count_sample_rate"`
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
	Enabled               *bool    `yaml:"enabled"`
	Address               string   `yaml:"address"`
	Database              string   `yaml:"database"`
	Table                 string   `yaml:"table"`
	Username              string   `yaml:"username"`
	Password              string   `yaml:"password"`
	FlushToStoreInterval  Duration `yaml:"flush_to_store_interval"`  // How often the app sends buffered events to ClickHouse
	FlushToDiskInterval   Duration `yaml:"flush_to_disk_interval"`   // How often ClickHouse flushes async inserts to disk (async_insert_busy_timeout_ms)
	FlushInterval         Duration `yaml:"flush_interval"`            // Deprecated: use flush_to_store_interval and flush_to_disk_interval
	BatchSize             int      `yaml:"batch_size"`
	RetentionDays         int      `yaml:"retention_days"`
	// SampleRate: fraction of queries to record (0.0-1.0). 1.0 = record all. Use <1.0 to reduce load at scale.
	SampleRate float64 `yaml:"sample_rate"`
	// AnonymizeClientIP: "none" (default), "hash" (SHA256 prefix), or "truncate" (/24 IPv4, /64 IPv6).
	// For GDPR/privacy in shared deployments.
	AnonymizeClientIP string `yaml:"anonymize_client_ip"`
}

// ClientIdentificationConfig maps client IPs to friendly names for per-device analytics.
// Enables "Which device queries X?" in query analytics.
type ClientIdentificationConfig struct {
	Enabled *bool             `yaml:"enabled"`
	Clients map[string]string `yaml:"clients"` // IP -> name, e.g. "192.168.1.10": "kids-phone"
}

type ControlConfig struct {
	Enabled *bool                  `yaml:"enabled"`
	Listen  string                 `yaml:"listen"`
	Token   string                 `yaml:"token"`
	Errors  *ErrorPersistenceConfig `yaml:"errors"`
}

// ErrorPersistenceConfig configures disk persistence for /errors endpoint.
// Enabled by default when control server is used.
type ErrorPersistenceConfig struct {
	Enabled         *bool  `yaml:"enabled"`          // Enable persistence (default true)
	RetentionDays   int    `yaml:"retention_days"`   // How many days to keep errors (default 7)
	Directory       string `yaml:"directory"`        // Directory for error log file (default "logs")
	FilenamePrefix  string `yaml:"filename_prefix"`  // Prefix for error log file (default "errors")
	LogLevel        string `yaml:"log_level"`       // Minimum level to buffer: "error", "warning" (default), "info", or "debug"
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

// WebhooksConfig enables webhooks for integration (e.g. Home Assistant, automation).
type WebhooksConfig struct {
	OnBlock *WebhookOnBlockConfig `yaml:"on_block"`
	OnError *WebhookOnErrorConfig `yaml:"on_error"`
}

// WebhookTarget defines a single webhook destination (URL + format + context).
type WebhookTarget struct {
	URL                 string         `yaml:"url"`
	Timeout             string         `yaml:"timeout"`  // e.g. "5s", default 5s
	Target              string         `yaml:"target"`   // "default" (raw JSON), "discord", "slack", etc.
	Format              string         `yaml:"format"`   // deprecated: use target
	Context             map[string]any `yaml:"context"`  // optional: tags, env, etc. merged into payload
	RateLimitPerMinute  int            `yaml:"rate_limit_per_minute"`  // legacy: max per minute; 0 = use default
	RateLimitMaxMessages int           `yaml:"rate_limit_max_messages"` // max webhooks in timeframe; 0 = default 60, -1 = unlimited
	RateLimitTimeframe   string        `yaml:"rate_limit_timeframe"`    // e.g. "1m", "5m", "1h"; default "1m"
}

type WebhookOnBlockConfig struct {
	Enabled              *bool           `yaml:"enabled"`
	URL                  string          `yaml:"url"`   // legacy: single target; used when targets is empty
	Timeout              string          `yaml:"timeout"`
	Target               string          `yaml:"target"`
	Format               string          `yaml:"format"`
	Context              map[string]any  `yaml:"context"`
	RateLimitPerMinute   int             `yaml:"rate_limit_per_minute"`   // legacy
	RateLimitMaxMessages int             `yaml:"rate_limit_max_messages"`
	RateLimitTimeframe   string          `yaml:"rate_limit_timeframe"`
	Targets              []WebhookTarget `yaml:"targets"` // multiple targets; each gets its own URL, target, context
}

// WebhookOnErrorConfig fires HTTP POST when a DNS query results in an error outcome
// (upstream_error, servfail, servfail_backoff, invalid).
type WebhookOnErrorConfig struct {
	Enabled              *bool           `yaml:"enabled"`
	URL                  string          `yaml:"url"`
	Timeout              string          `yaml:"timeout"`
	Target               string          `yaml:"target"`
	Format               string          `yaml:"format"`
	Context              map[string]any  `yaml:"context"`
	RateLimitPerMinute   int             `yaml:"rate_limit_per_minute"`   // legacy
	RateLimitMaxMessages int             `yaml:"rate_limit_max_messages"`
	RateLimitTimeframe   string          `yaml:"rate_limit_timeframe"`
	Targets              []WebhookTarget `yaml:"targets"`
}

// EffectiveTargets returns the list of webhook targets to use. When targets is non-empty, returns those.
// Otherwise, if url is set (legacy), returns a single target built from url/target/context.
func (c *WebhookOnBlockConfig) EffectiveTargets() []WebhookTarget {
	if c == nil {
		return nil
	}
	if len(c.Targets) > 0 {
		return c.Targets
	}
	if strings.TrimSpace(c.URL) == "" {
		return nil
	}
	t := WebhookTarget{
		URL:                  c.URL,
		Timeout:              c.Timeout,
		Target:               c.Target,
		Format:               c.Format,
		Context:              c.Context,
		RateLimitPerMinute:   c.RateLimitPerMinute,
		RateLimitMaxMessages: c.RateLimitMaxMessages,
		RateLimitTimeframe:   c.RateLimitTimeframe,
	}
	return []WebhookTarget{t}
}

// EffectiveTargets returns the list of webhook targets to use.
func (c *WebhookOnErrorConfig) EffectiveTargets() []WebhookTarget {
	if c == nil {
		return nil
	}
	if len(c.Targets) > 0 {
		return c.Targets
	}
	if strings.TrimSpace(c.URL) == "" {
		return nil
	}
	t := WebhookTarget{
		URL:                  c.URL,
		Timeout:              c.Timeout,
		Target:               c.Target,
		Format:               c.Format,
		Context:              c.Context,
		RateLimitPerMinute:   c.RateLimitPerMinute,
		RateLimitMaxMessages: c.RateLimitMaxMessages,
		RateLimitTimeframe:   c.RateLimitTimeframe,
	}
	return []WebhookTarget{t}
}

// EffectiveRateLimit returns the effective max messages and timeframe for the target.
// Uses parent's values when target's are unset. Returns (maxMessages, timeframe).
// When maxMessages <= 0, rate limiting is disabled (unlimited).
func (t *WebhookTarget) EffectiveRateLimit(parentMaxMessages int, parentTimeframe string) (maxMessages int, timeframe time.Duration) {
	maxMessages = t.RateLimitMaxMessages
	tf := t.RateLimitTimeframe
	if maxMessages == 0 && t.RateLimitPerMinute != 0 {
		maxMessages = t.RateLimitPerMinute
		tf = "1m"
	}
	if maxMessages == 0 {
		maxMessages = parentMaxMessages
		tf = parentTimeframe
	}
	if maxMessages <= 0 {
		return -1, 0
	}
	if tf == "" {
		tf = "1m"
	}
	d, err := time.ParseDuration(tf)
	if err != nil || d <= 0 {
		d = time.Minute
	}
	return maxMessages, d
}

func applyWebhookRateLimitDefaults(cfg *WebhookOnBlockConfig) {
	if cfg == nil {
		return
	}
	if cfg.RateLimitPerMinute == -1 {
		cfg.RateLimitMaxMessages = -1
		if cfg.RateLimitTimeframe == "" {
			cfg.RateLimitTimeframe = "1m"
		}
		return
	}
	if cfg.RateLimitMaxMessages == 0 && cfg.RateLimitPerMinute > 0 {
		cfg.RateLimitMaxMessages = cfg.RateLimitPerMinute
		if cfg.RateLimitTimeframe == "" {
			cfg.RateLimitTimeframe = "1m"
		}
		return
	}
	if cfg.RateLimitMaxMessages == 0 {
		cfg.RateLimitMaxMessages = 60
		if cfg.RateLimitTimeframe == "" {
			cfg.RateLimitTimeframe = "1m"
		}
	}
}

func applyWebhookRateLimitDefaultsError(cfg *WebhookOnErrorConfig) {
	if cfg == nil {
		return
	}
	if cfg.RateLimitPerMinute == -1 {
		cfg.RateLimitMaxMessages = -1
		if cfg.RateLimitTimeframe == "" {
			cfg.RateLimitTimeframe = "1m"
		}
		return
	}
	if cfg.RateLimitMaxMessages == 0 && cfg.RateLimitPerMinute > 0 {
		cfg.RateLimitMaxMessages = cfg.RateLimitPerMinute
		if cfg.RateLimitTimeframe == "" {
			cfg.RateLimitTimeframe = "1m"
		}
		return
	}
	if cfg.RateLimitMaxMessages == 0 {
		cfg.RateLimitMaxMessages = 60
		if cfg.RateLimitTimeframe == "" {
			cfg.RateLimitTimeframe = "1m"
		}
	}
}

// SafeSearchConfig forces safe search for Google, Bing, etc. (parental controls).
type SafeSearchConfig struct {
	Enabled *bool `yaml:"enabled"`
	// Engines: google, bing (duckduckgo uses URL param, not DNS-level)
	Google *bool `yaml:"google"`
	Bing   *bool `yaml:"bing"`
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
	applyRedisEnvOverrides(&cfg)
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
	if cfg.Server.ReusePort != nil && *cfg.Server.ReusePort && cfg.Server.ReusePortListeners <= 0 {
		n := runtime.NumCPU()
		if n < 1 {
			n = 1
		}
		if n > 16 {
			n = 16
		}
		cfg.Server.ReusePortListeners = n
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
	if cfg.Cache.Refresh.MaxBatchSize == 0 {
		if cfg.Cache.Refresh.BatchSize > 0 {
			cfg.Cache.Refresh.MaxBatchSize = cfg.Cache.Refresh.BatchSize
		} else {
			cfg.Cache.Refresh.MaxBatchSize = 2000
		}
	}
	if cfg.Cache.Refresh.SweepMinHits == 0 {
		cfg.Cache.Refresh.SweepMinHits = 1
	}
	if cfg.Cache.Refresh.SweepHitWindow.Duration == 0 {
		cfg.Cache.Refresh.SweepHitWindow.Duration = 48 * time.Hour
	}
	if cfg.Cache.Refresh.BatchStatsWindow.Duration == 0 {
		cfg.Cache.Refresh.BatchStatsWindow.Duration = 2 * time.Hour
	}
	if cfg.Cache.Refresh.HitCountSampleRate <= 0 || cfg.Cache.Refresh.HitCountSampleRate > 1 {
		cfg.Cache.Refresh.HitCountSampleRate = 1.0
	} else if cfg.Cache.Refresh.HitCountSampleRate < 0.01 {
		cfg.Cache.Refresh.HitCountSampleRate = 0.01
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
	// Backward compat: flush_interval populates both if new fields are unset
	if cfg.QueryStore.FlushToStoreInterval.Duration == 0 {
		if cfg.QueryStore.FlushInterval.Duration > 0 {
			cfg.QueryStore.FlushToStoreInterval.Duration = cfg.QueryStore.FlushInterval.Duration
		} else {
			cfg.QueryStore.FlushToStoreInterval.Duration = 5 * time.Second
		}
	}
	if cfg.QueryStore.FlushToDiskInterval.Duration == 0 {
		if cfg.QueryStore.FlushInterval.Duration > 0 {
			cfg.QueryStore.FlushToDiskInterval.Duration = cfg.QueryStore.FlushInterval.Duration
		} else {
			cfg.QueryStore.FlushToDiskInterval.Duration = 5 * time.Second
		}
	}
	if cfg.QueryStore.BatchSize == 0 {
		cfg.QueryStore.BatchSize = 2000
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
	if cfg.Control.Errors == nil {
		cfg.Control.Errors = &ErrorPersistenceConfig{}
	}
	if cfg.Control.Errors.Enabled == nil {
		cfg.Control.Errors.Enabled = boolPtr(true)
	}
	if cfg.Control.Errors.RetentionDays <= 0 {
		cfg.Control.Errors.RetentionDays = 7
	}
	if cfg.Control.Errors.Directory == "" {
		cfg.Control.Errors.Directory = "logs"
	}
	if cfg.Control.Errors.FilenamePrefix == "" {
		cfg.Control.Errors.FilenamePrefix = "errors"
	}
	if cfg.Control.Errors.LogLevel == "" {
		cfg.Control.Errors.LogLevel = "warning"
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
	if cfg.UpstreamTimeout.Duration <= 0 {
		cfg.UpstreamTimeout.Duration = 10 * time.Second
	}
	if cfg.UpstreamBackoff == nil {
		cfg.UpstreamBackoff = &Duration{Duration: 30 * time.Second}
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
	if cfg.Blocklists.HealthCheck != nil && cfg.Blocklists.HealthCheck.Enabled == nil {
		cfg.Blocklists.HealthCheck.Enabled = boolPtr(true)
	}
	if cfg.Blocklists.HealthCheck != nil && cfg.Blocklists.HealthCheck.FailOnAny == nil {
		cfg.Blocklists.HealthCheck.FailOnAny = boolPtr(true)
	}
	if cfg.Blocklists.ScheduledPause != nil && cfg.Blocklists.ScheduledPause.Enabled == nil {
		cfg.Blocklists.ScheduledPause.Enabled = boolPtr(true)
	}
	// Webhook rate limit: default 60 messages per 1m; -1 = unlimited
	applyWebhookRateLimitDefaults(cfg.Webhooks.OnBlock)
	applyWebhookRateLimitDefaultsError(cfg.Webhooks.OnError)
	if cfg.QueryStore.AnonymizeClientIP == "" {
		cfg.QueryStore.AnonymizeClientIP = "none"
	}
	if cfg.Cache.Redis.Mode == "" {
		cfg.Cache.Redis.Mode = "standalone"
	}
	// UI hostname is optional, will use OS hostname if not set
}

// applyRedisEnvOverrides applies environment variable overrides for Redis config.
// Supported env vars:
//   - REDIS_ADDRESS or REDIS_URL: override cache.redis.address (standalone)
//   - REDIS_MODE: "standalone" (default), "sentinel", or "cluster"
//   - REDIS_SENTINEL_ADDRS: comma-separated sentinel addresses (when mode=sentinel)
//   - REDIS_MASTER_NAME: sentinel master name (when mode=sentinel)
//   - REDIS_CLUSTER_ADDRS: comma-separated cluster node addresses (when mode=cluster)
func applyRedisEnvOverrides(cfg *Config) {
	// Address (standalone, or fallback for sentinel/cluster when *_ADDRS not set)
	addr := strings.TrimSpace(os.Getenv("REDIS_ADDRESS"))
	if addr == "" {
		u := strings.TrimSpace(os.Getenv("REDIS_URL"))
		if u != "" {
			parsed, err := url.Parse(u)
			if err == nil && parsed.Host != "" {
				addr = parsed.Host
			}
		}
	}
	if addr != "" {
		cfg.Cache.Redis.Address = addr
	}

	// Mode
	if m := strings.TrimSpace(os.Getenv("REDIS_MODE")); m != "" {
		cfg.Cache.Redis.Mode = strings.ToLower(m)
	}

	// Sentinel
	if s := strings.TrimSpace(os.Getenv("REDIS_SENTINEL_ADDRS")); s != "" {
		parts := strings.Split(s, ",")
		cfg.Cache.Redis.SentinelAddrs = make([]string, 0, len(parts))
		for _, p := range parts {
			if t := strings.TrimSpace(p); t != "" {
				cfg.Cache.Redis.SentinelAddrs = append(cfg.Cache.Redis.SentinelAddrs, t)
			}
		}
	}
	if mn := strings.TrimSpace(os.Getenv("REDIS_MASTER_NAME")); mn != "" {
		cfg.Cache.Redis.MasterName = mn
	}

	// Cluster
	if c := strings.TrimSpace(os.Getenv("REDIS_CLUSTER_ADDRS")); c != "" {
		parts := strings.Split(c, ",")
		cfg.Cache.Redis.ClusterAddrs = make([]string, 0, len(parts))
		for _, p := range parts {
			if t := strings.TrimSpace(p); t != "" {
				cfg.Cache.Redis.ClusterAddrs = append(cfg.Cache.Redis.ClusterAddrs, t)
			}
		}
	}
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
	cfg.Cache.Redis.Mode = strings.ToLower(strings.TrimSpace(cfg.Cache.Redis.Mode))
	if cfg.Cache.Redis.Mode != "standalone" && cfg.Cache.Redis.Mode != "sentinel" && cfg.Cache.Redis.Mode != "cluster" {
		cfg.Cache.Redis.Mode = "standalone"
	}
	if cfg.Cache.Redis.Mode == "sentinel" && len(cfg.Cache.Redis.SentinelAddrs) == 0 && cfg.Cache.Redis.Address != "" {
		cfg.Cache.Redis.SentinelAddrs = strings.Split(cfg.Cache.Redis.Address, ",")
		for i := range cfg.Cache.Redis.SentinelAddrs {
			cfg.Cache.Redis.SentinelAddrs[i] = strings.TrimSpace(cfg.Cache.Redis.SentinelAddrs[i])
		}
	}
	cfg.QueryStore.AnonymizeClientIP = strings.ToLower(strings.TrimSpace(cfg.QueryStore.AnonymizeClientIP))
	if cfg.QueryStore.AnonymizeClientIP != "none" && cfg.QueryStore.AnonymizeClientIP != "hash" && cfg.QueryStore.AnonymizeClientIP != "truncate" {
		cfg.QueryStore.AnonymizeClientIP = "none"
	}
	cfg.Cache.Refresh.MaxInflight = maxInt(cfg.Cache.Refresh.MaxInflight, 0)
	cfg.Cache.Refresh.MaxBatchSize = maxInt(cfg.Cache.Refresh.MaxBatchSize, 0)
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
	if cfg.Control.Errors != nil {
		cfg.Control.Errors.LogLevel = strings.ToLower(strings.TrimSpace(cfg.Control.Errors.LogLevel))
		if cfg.Control.Errors.LogLevel != "error" && cfg.Control.Errors.LogLevel != "warning" && cfg.Control.Errors.LogLevel != "info" && cfg.Control.Errors.LogLevel != "debug" {
			cfg.Control.Errors.LogLevel = "warning"
		}
	}
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
	if cfg.Server.ReusePort != nil && *cfg.Server.ReusePort {
		if cfg.Server.ReusePortListeners < 1 || cfg.Server.ReusePortListeners > 64 {
			return fmt.Errorf("server.reuse_port_listeners must be between 1 and 64 when reuse_port is true (got %d)", cfg.Server.ReusePortListeners)
		}
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
	if cfg.Blocklists.ScheduledPause != nil && cfg.Blocklists.ScheduledPause.Enabled != nil && *cfg.Blocklists.ScheduledPause.Enabled {
		if err := validateTimeWindow(cfg.Blocklists.ScheduledPause.Start, cfg.Blocklists.ScheduledPause.End); err != nil {
			return fmt.Errorf("blocklists.scheduled_pause: %w", err)
		}
		for _, d := range cfg.Blocklists.ScheduledPause.Days {
			if d < 0 || d > 6 {
				return fmt.Errorf("blocklists.scheduled_pause.days must be 0-6 (Sun-Sat), got %d", d)
			}
		}
	}
	if cfg.Cache.Redis.Mode == "sentinel" {
		if strings.TrimSpace(cfg.Cache.Redis.MasterName) == "" {
			return fmt.Errorf("cache.redis.master_name is required when mode is sentinel")
		}
		addrs := cfg.Cache.Redis.SentinelAddrs
		if len(addrs) == 0 && strings.TrimSpace(cfg.Cache.Redis.Address) != "" {
			addrs = strings.Split(cfg.Cache.Redis.Address, ",")
			for i := range addrs {
				addrs[i] = strings.TrimSpace(addrs[i])
			}
		}
		if len(addrs) == 0 {
			return fmt.Errorf("cache.redis.sentinel_addrs or cache.redis.address (comma-separated) is required when mode is sentinel")
		}
	}
	if cfg.Cache.Redis.Mode == "cluster" {
		addrs := cfg.Cache.Redis.ClusterAddrs
		if len(addrs) == 0 && strings.TrimSpace(cfg.Cache.Redis.Address) != "" {
			// Allow address as comma-separated for cluster
			addrs = strings.Split(cfg.Cache.Redis.Address, ",")
			for i := range addrs {
				addrs[i] = strings.TrimSpace(addrs[i])
			}
		}
		if len(addrs) == 0 {
			return fmt.Errorf("cache.redis.cluster_addrs or cache.redis.address (comma-separated) is required when mode is cluster")
		}
	}
	if cfg.Cache.ServfailRefreshThreshold != nil && *cfg.Cache.ServfailRefreshThreshold < 0 {
		return fmt.Errorf("cache.servfail_refresh_threshold must be zero or greater")
	}
	if cfg.Cache.ServfailLogInterval.Duration < 0 {
		return fmt.Errorf("cache.servfail_log_interval must be zero or greater")
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
		if cfg.Cache.Refresh.MaxBatchSize <= 0 {
			return fmt.Errorf("cache.refresh.max_batch_size must be greater than zero")
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

// validateTimeWindow checks HH:MM format for start/end.
func validateTimeWindow(start, end string) error {
	parse := func(s string) (h, m int, err error) {
		if len(s) != 5 || s[2] != ':' {
			return 0, 0, fmt.Errorf("expected HH:MM, got %q", s)
		}
		if _, err := fmt.Sscanf(s, "%d:%d", &h, &m); err != nil {
			return 0, 0, fmt.Errorf("invalid time %q: %w", s, err)
		}
		if h < 0 || h > 23 || m < 0 || m > 59 {
			return 0, 0, fmt.Errorf("invalid time %q: hour 0-23, minute 0-59", s)
		}
		return h, m, nil
	}
	sh, sm, err := parse(strings.TrimSpace(start))
	if err != nil {
		return fmt.Errorf("start: %w", err)
	}
	eh, em, err := parse(strings.TrimSpace(end))
	if err != nil {
		return fmt.Errorf("end: %w", err)
	}
	if sh > eh || (sh == eh && sm >= em) {
		return fmt.Errorf("start %s must be before end %s", start, end)
	}
	return nil
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
