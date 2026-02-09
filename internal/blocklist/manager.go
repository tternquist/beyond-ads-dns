package blocklist

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/tternquist/beyond-ads-dns/internal/config"
)

type domainMatcher struct {
	exact map[string]struct{}
	regex []*regexp.Regexp
}

type Snapshot struct {
	blocked     map[string]struct{}
	allow       *domainMatcher
	deny        *domainMatcher
	bloomFilter *BloomFilter
}

type Stats struct {
	Blocked int                `json:"blocked"`
	Allow   int                `json:"allow"`
	Deny    int                `json:"deny"`
	Bloom   *BloomStats        `json:"bloom,omitempty"`
}

type Manager struct {
	sources         []config.BlocklistSource
	refreshInterval time.Duration
	client          *http.Client
	logger          *log.Logger

	allowMatcher *domainMatcher
	denyMatcher  *domainMatcher

	configMu  sync.RWMutex
	snapshot  atomic.Value
	pauseInfo atomic.Value // stores *PauseInfo
}

type PauseInfo struct {
	Paused bool
	Until  time.Time
}

func NewManager(cfg config.BlocklistConfig, logger *log.Logger) *Manager {
	manager := &Manager{
		sources:         cfg.Sources,
		refreshInterval: cfg.RefreshInterval.Duration,
		client: &http.Client{
			Timeout: 15 * time.Second,
		},
		logger:       logger,
		allowMatcher: normalizeList(cfg.Allowlist, logger),
		denyMatcher:  normalizeList(cfg.Denylist, logger),
	}
	manager.snapshot.Store(&Snapshot{
		blocked: map[string]struct{}{},
		allow:   manager.allowMatcher,
		deny:    manager.denyMatcher,
	})
	return manager
}

func (m *Manager) Start(ctx context.Context) {
	if err := m.LoadOnce(ctx); err != nil && m.logger != nil {
		m.logger.Printf("blocklist initial load failed: %v", err)
	}
	m.configMu.RLock()
	refreshInterval := m.refreshInterval
	sourceCount := len(m.sources)
	m.configMu.RUnlock()
	if refreshInterval <= 0 || sourceCount == 0 {
		return
	}
	ticker := time.NewTicker(refreshInterval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := m.LoadOnce(ctx); err != nil && m.logger != nil {
					m.logger.Printf("blocklist refresh failed: %v", err)
				}
			}
		}
	}()
}

func (m *Manager) LoadOnce(ctx context.Context) error {
	m.configMu.RLock()
	sources := append([]config.BlocklistSource(nil), m.sources...)
	allowMatcher := m.allowMatcher
	denyMatcher := m.denyMatcher
	m.configMu.RUnlock()

	if len(sources) == 0 {
		m.snapshot.Store(&Snapshot{
			blocked:     map[string]struct{}{},
			allow:       allowMatcher,
			deny:        denyMatcher,
			bloomFilter: nil,
		})
		return nil
	}
	blocked := make(map[string]struct{})
	failures := 0
	for _, source := range sources {
		if source.URL == "" {
			continue
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, source.URL, nil)
		if err != nil {
			failures++
			m.logf("blocklist source %q request failed: %v", source.Name, err)
			continue
		}
		resp, err := m.client.Do(req)
		if err != nil {
			failures++
			m.logf("blocklist source %q fetch failed: %v", source.Name, err)
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			resp.Body.Close()
			failures++
			m.logf("blocklist source %q returned status %d", source.Name, resp.StatusCode)
			continue
		}
		entries, err := ParseDomains(resp.Body)
		resp.Body.Close()
		if err != nil {
			failures++
			m.logf("blocklist source %q parse failed: %v", source.Name, err)
			continue
		}
		for domain := range entries {
			blocked[domain] = struct{}{}
		}
	}
	if failures == len(sources) {
		return fmt.Errorf("all blocklist sources failed")
	}
	
	// Create bloom filter for fast negative lookups
	// Use 0.1% false positive rate for better performance
	var bloom *BloomFilter
	if len(blocked) > 0 {
		bloom = NewBloomFilter(len(blocked), 0.001)
		for domain := range blocked {
			bloom.Add(domain)
		}
		if m.logger != nil {
			stats := bloom.Stats()
			m.logger.Printf("blocklist bloom filter: %d domains, %.2f%% fill ratio, estimated FPR: %.6f",
				len(blocked), stats.FillRatio*100, stats.EstimatedFPR)
		}
	}
	
	m.snapshot.Store(&Snapshot{
		blocked:     blocked,
		allow:       allowMatcher,
		deny:        denyMatcher,
		bloomFilter: bloom,
	})
	return nil
}

func (m *Manager) ApplyConfig(ctx context.Context, cfg config.BlocklistConfig) error {
	m.configMu.Lock()
	m.sources = cfg.Sources
	m.refreshInterval = cfg.RefreshInterval.Duration
	m.allowMatcher = normalizeList(cfg.Allowlist, m.logger)
	m.denyMatcher = normalizeList(cfg.Denylist, m.logger)
	m.configMu.Unlock()

	return m.LoadOnce(ctx)
}

func (m *Manager) IsBlocked(qname string) bool {
	// Check if blocking is paused
	if m.IsPaused() {
		return false
	}
	
	snap := m.snapshot.Load()
	if snap == nil {
		return false
	}
	normalized := normalizeQueryName(qname)
	if normalized == "" {
		return false
	}
	snapshot := snap.(*Snapshot)
	if domainMatch(snapshot.allow, normalized) {
		return false
	}
	if domainMatch(snapshot.deny, normalized) {
		return true
	}
	
	// Fast path: Use bloom filter for quick negative lookups
	// If bloom filter says it's not in the set, we can skip the map lookup entirely
	if snapshot.bloomFilter != nil {
		// Check all subdomain variants in bloom filter
		remaining := normalized
		inBloom := false
		for {
			if snapshot.bloomFilter.MayContain(remaining) {
				inBloom = true
				break
			}
			index := strings.IndexByte(remaining, '.')
			if index == -1 {
				break
			}
			remaining = remaining[index+1:]
		}
		// If bloom filter says definitely not blocked, skip map lookup
		if !inBloom {
			return false
		}
	}
	
	// Check blocked domains from sources (exact match with subdomain support)
	return domainMatchExact(snapshot.blocked, normalized)
}

func (m *Manager) Pause(duration time.Duration) {
	until := time.Now().Add(duration)
	m.pauseInfo.Store(&PauseInfo{
		Paused: true,
		Until:  until,
	})
}

func (m *Manager) Resume() {
	m.pauseInfo.Store(&PauseInfo{
		Paused: false,
		Until:  time.Time{},
	})
}

func (m *Manager) IsPaused() bool {
	info := m.pauseInfo.Load()
	if info == nil {
		return false
	}
	pauseInfo := info.(*PauseInfo)
	if !pauseInfo.Paused {
		return false
	}
	// Check if pause has expired
	if time.Now().After(pauseInfo.Until) {
		m.Resume()
		return false
	}
	return true
}

func (m *Manager) PauseStatus() PauseInfo {
	info := m.pauseInfo.Load()
	if info == nil {
		return PauseInfo{Paused: false}
	}
	pauseInfo := info.(*PauseInfo)
	// Check if pause has expired
	if pauseInfo.Paused && time.Now().After(pauseInfo.Until) {
		m.Resume()
		return PauseInfo{Paused: false}
	}
	return *pauseInfo
}

func (m *Manager) Stats() Stats {
	snap := m.snapshot.Load()
	if snap == nil {
		return Stats{}
	}
	snapshot := snap.(*Snapshot)
	allowCount := 0
	denyCount := 0
	if snapshot.allow != nil {
		allowCount = len(snapshot.allow.exact) + len(snapshot.allow.regex)
	}
	if snapshot.deny != nil {
		denyCount = len(snapshot.deny.exact) + len(snapshot.deny.regex)
	}
	
	var bloomStats *BloomStats
	if snapshot.bloomFilter != nil {
		stats := snapshot.bloomFilter.Stats()
		bloomStats = &stats
	}
	
	return Stats{
		Blocked: len(snapshot.blocked),
		Allow:   allowCount,
		Deny:    denyCount,
		Bloom:   bloomStats,
	}
}

func normalizeList(domains []string, logger *log.Logger) *domainMatcher {
	matcher := &domainMatcher{
		exact: make(map[string]struct{}),
		regex: make([]*regexp.Regexp, 0),
	}
	for _, domain := range domains {
		trimmed := strings.TrimSpace(domain)
		if trimmed == "" {
			continue
		}
		// Check if it's a regex pattern (wrapped in /)
		if strings.HasPrefix(trimmed, "/") && strings.HasSuffix(trimmed, "/") && len(trimmed) > 2 {
			pattern := trimmed[1 : len(trimmed)-1]
			re, err := regexp.Compile(pattern)
			if err != nil {
				if logger != nil {
					logger.Printf("invalid regex pattern %q: %v", trimmed, err)
				}
				continue
			}
			matcher.regex = append(matcher.regex, re)
		} else {
			// Treat as exact domain match
			normalized, ok := normalizeDomain(domain)
			if !ok {
				continue
			}
			matcher.exact[normalized] = struct{}{}
		}
	}
	return matcher
}

func normalizeQueryName(name string) string {
	trimmed := strings.TrimSpace(strings.TrimSuffix(name, "."))
	return strings.ToLower(trimmed)
}

func domainMatch(matcher *domainMatcher, name string) bool {
	if matcher == nil {
		return false
	}
	// Check exact matches first (including parent domain matching)
	if len(matcher.exact) > 0 {
		remaining := name
		for {
			if _, ok := matcher.exact[remaining]; ok {
				return true
			}
			index := strings.IndexByte(remaining, '.')
			if index == -1 {
				break
			}
			remaining = remaining[index+1:]
		}
	}
	// Check regex patterns
	if len(matcher.regex) > 0 {
		for _, re := range matcher.regex {
			if re.MatchString(name) {
				return true
			}
		}
	}
	return false
}

func domainMatchExact(set map[string]struct{}, name string) bool {
	if len(set) == 0 {
		return false
	}
	remaining := name
	for {
		if _, ok := set[remaining]; ok {
			return true
		}
		index := strings.IndexByte(remaining, '.')
		if index == -1 {
			break
		}
		remaining = remaining[index+1:]
	}
	return false
}

func (m *Manager) logf(format string, args ...interface{}) {
	if m.logger == nil {
		return
	}
	m.logger.Printf(format, args...)
}
