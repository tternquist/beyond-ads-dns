package blocklist

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/tternquist/beyond-ads-dns/internal/config"
)

type Snapshot struct {
	blocked map[string]struct{}
	allow   map[string]struct{}
	deny    map[string]struct{}
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

	allowSet map[string]struct{}
	denySet  map[string]struct{}

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
		logger:   logger,
		allowSet: normalizeList(cfg.Allowlist),
		denySet:  normalizeList(cfg.Denylist),
	}
	manager.snapshot.Store(&Snapshot{
		blocked: map[string]struct{}{},
		allow:   manager.allowSet,
		deny:    manager.denySet,
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
	allowSet := m.allowSet
	denySet := m.denySet
	m.configMu.RUnlock()

	if len(sources) == 0 {
		m.snapshot.Store(&Snapshot{
			blocked: map[string]struct{}{},
			allow:   allowSet,
			deny:    denySet,
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
		allow:   allowSet,
		deny:    denySet,
	})
	return nil
}

func (m *Manager) ApplyConfig(ctx context.Context, cfg config.BlocklistConfig) error {
	m.configMu.Lock()
	m.sources = cfg.Sources
	m.refreshInterval = cfg.RefreshInterval.Duration
	m.allowSet = normalizeList(cfg.Allowlist)
	m.denySet = normalizeList(cfg.Denylist)
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
	return domainMatch(snapshot.blocked, normalized)
}

func (m *Manager) Stats() Stats {
	snap := m.snapshot.Load()
	if snap == nil {
		return Stats{}
	}
	snapshot := snap.(*Snapshot)
	return Stats{
		Blocked: len(snapshot.blocked),
		Allow:   len(snapshot.allow),
		Deny:    len(snapshot.deny),
	}
}

func normalizeList(domains []string) map[string]struct{} {
	set := make(map[string]struct{})
	for _, domain := range domains {
		normalized, ok := normalizeDomain(domain)
		if !ok {
			continue
		}
		set[normalized] = struct{}{}
	}
	return set
}

func normalizeQueryName(name string) string {
	trimmed := strings.TrimSpace(strings.TrimSuffix(name, "."))
	return strings.ToLower(trimmed)
}

func domainMatch(set map[string]struct{}, name string) bool {
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
