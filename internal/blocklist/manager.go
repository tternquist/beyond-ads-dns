package blocklist

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/tternquist/beyond-ads-dns/internal/config"
)

type Snapshot struct {
	blocked map[string]struct{}
	allow   map[string]struct{}
	deny    map[string]struct{}
}

type Manager struct {
	sources         []config.BlocklistSource
	refreshInterval time.Duration
	client          *http.Client
	logger          *log.Logger

	allowSet map[string]struct{}
	denySet  map[string]struct{}

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
	if m.refreshInterval <= 0 || len(m.sources) == 0 {
		return
	}
	ticker := time.NewTicker(m.refreshInterval)
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
	if len(m.sources) == 0 {
		m.snapshot.Store(&Snapshot{
			blocked: map[string]struct{}{},
			allow:   m.allowSet,
			deny:    m.denySet,
		})
		return nil
	}
	blocked := make(map[string]struct{})
	failures := 0
	for _, source := range m.sources {
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
	if failures == len(m.sources) {
		return fmt.Errorf("all blocklist sources failed")
	}
	m.snapshot.Store(&Snapshot{
		blocked: blocked,
		allow:   m.allowSet,
		deny:    m.denySet,
	})
	return nil
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
