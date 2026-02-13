package config

import (
	"fmt"
	"net"
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
	Server     ServerConfig     `yaml:"server"`
	Upstreams  []UpstreamConfig `yaml:"upstreams"`
	Blocklists BlocklistConfig  `yaml:"blocklists"`
	Cache      CacheConfig      `yaml:"cache"`
	Response   ResponseConfig   `yaml:"response"`
	RequestLog RequestLogConfig `yaml:"request_log"`
	QueryStore QueryStoreConfig `yaml:"query_store"`
	Control    ControlConfig    `yaml:"control"`
	UI         UIConfig         `yaml:"ui"`
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
}

type ControlConfig struct {
	Enabled *bool  `yaml:"enabled"`
	Listen  string `yaml:"listen"`
	Token   string `yaml:"token"`
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
	if cfg.Control.Enabled == nil {
		cfg.Control.Enabled = boolPtr(false)
	}
	if cfg.Control.Listen == "" {
		cfg.Control.Listen = "0.0.0.0:8081"
	}
	if len(cfg.Upstreams) == 0 {
		cfg.Upstreams = []UpstreamConfig{
			{Name: "cloudflare", Address: "1.1.1.1:53", Protocol: "udp"},
			{Name: "cloudflare-secondary", Address: "1.0.0.1:53", Protocol: "udp"},
		}
	}
	// UI hostname is optional, will use OS hostname if not set
}

func normalize(cfg *Config) {
	cfg.Response.Blocked = strings.ToLower(strings.TrimSpace(cfg.Response.Blocked))
	for i := range cfg.Server.Protocols {
		cfg.Server.Protocols[i] = strings.ToLower(strings.TrimSpace(cfg.Server.Protocols[i]))
	}
	for i := range cfg.Upstreams {
		cfg.Upstreams[i].Protocol = strings.ToLower(strings.TrimSpace(cfg.Upstreams[i].Protocol))
		cfg.Upstreams[i].Address = strings.TrimSpace(cfg.Upstreams[i].Address)
		cfg.Upstreams[i].Name = strings.TrimSpace(cfg.Upstreams[i].Name)
	}
	cfg.Cache.Redis.Address = strings.TrimSpace(cfg.Cache.Redis.Address)
	cfg.Cache.Refresh.MaxInflight = maxInt(cfg.Cache.Refresh.MaxInflight, 0)
	cfg.Cache.Refresh.BatchSize = maxInt(cfg.Cache.Refresh.BatchSize, 0)
	cfg.RequestLog.Directory = strings.TrimSpace(cfg.RequestLog.Directory)
	cfg.RequestLog.FilenamePrefix = strings.TrimSpace(cfg.RequestLog.FilenamePrefix)
	cfg.QueryStore.Address = strings.TrimSpace(cfg.QueryStore.Address)
	cfg.QueryStore.Database = strings.TrimSpace(cfg.QueryStore.Database)
	cfg.QueryStore.Table = strings.TrimSpace(cfg.QueryStore.Table)
	cfg.QueryStore.Username = strings.TrimSpace(cfg.QueryStore.Username)
	cfg.QueryStore.Password = strings.TrimSpace(cfg.QueryStore.Password)
	cfg.Control.Listen = strings.TrimSpace(cfg.Control.Listen)
	cfg.Control.Token = strings.TrimSpace(cfg.Control.Token)
	cfg.UI.Hostname = strings.TrimSpace(cfg.UI.Hostname)
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
	for _, upstream := range cfg.Upstreams {
		if upstream.Address == "" {
			return fmt.Errorf("upstream address must not be empty")
		}
		if _, _, err := net.SplitHostPort(upstream.Address); err != nil {
			return fmt.Errorf("invalid upstream address %q: %w", upstream.Address, err)
		}
		if upstream.Protocol != "" && upstream.Protocol != "udp" && upstream.Protocol != "tcp" {
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
