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
	blocked map[string]struct{}
	allow   *domainMatcher
	deny    *domainMatcher
}

type Stats struct {
	Blocked int
	Allow   int
	Deny    int
}

type Manager struct {
	sources         []config.BlocklistSource
	refreshInterval time.Duration
	client          *http.Client
	logger          *log.Logger

	allowMatcher *domainMatcher
	denyMatcher  *domainMatcher

	configMu sync.RWMutex
	snapshot atomic.Value
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
			blocked: map[string]struct{}{},
			allow:   allowMatcher,
			deny:    denyMatcher,
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
	m.snapshot.Store(&Snapshot{
		blocked: blocked,
		allow:   allowMatcher,
		deny:    denyMatcher,
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
	// Check blocked domains from sources (exact match only, no regex)
	return domainMatchExact(snapshot.blocked, normalized)
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
	return Stats{
		Blocked: len(snapshot.blocked),
		Allow:   allowCount,
		Deny:    denyCount,
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
