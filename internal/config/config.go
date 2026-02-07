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
	Redis       RedisConfig `yaml:"redis"`
	MinTTL      Duration    `yaml:"min_ttl"`
	MaxTTL      Duration    `yaml:"max_ttl"`
	NegativeTTL Duration    `yaml:"negative_ttl"`
}

type RedisConfig struct {
	Address  string `yaml:"address"`
	DB       int    `yaml:"db"`
	Password string `yaml:"password"`
}

type ResponseConfig struct {
	Blocked    string   `yaml:"blocked"`
	BlockedTTL Duration `yaml:"blocked_ttl"`
}

func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("parse config: %w", err)
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
		cfg.Cache.MinTTL.Duration = 30 * time.Second
	}
	if cfg.Cache.MaxTTL.Duration == 0 {
		cfg.Cache.MaxTTL.Duration = time.Hour
	}
	if cfg.Cache.NegativeTTL.Duration == 0 {
		cfg.Cache.NegativeTTL.Duration = 5 * time.Minute
	}
	if cfg.Response.Blocked == "" {
		cfg.Response.Blocked = defaultBlockedResponse
	}
	if cfg.Response.BlockedTTL.Duration == 0 {
		cfg.Response.BlockedTTL.Duration = 5 * time.Minute
	}
	if len(cfg.Upstreams) == 0 {
		cfg.Upstreams = []UpstreamConfig{
			{Name: "cloudflare", Address: "1.1.1.1:53", Protocol: "udp"},
			{Name: "cloudflare-secondary", Address: "1.0.0.1:53", Protocol: "udp"},
		}
	}
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
	return nil
}
