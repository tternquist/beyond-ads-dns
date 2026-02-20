package blocklist

import (
	"context"
	"fmt"
	"io"
	"log/slog"
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
	logger          *slog.Logger
	logAttrs        []any // optional key-value pairs for logging (e.g. "group_id", "kids") to disambiguate global vs per-group blocklists

	allowMatcher *domainMatcher
	denyMatcher  *domainMatcher

	configMu  sync.RWMutex
	snapshot  atomic.Value
	pauseInfo atomic.Value // stores *PauseInfo

	lastAppliedCfg *config.BlocklistConfig // for skip-reload when unchanged
	schedPause    atomic.Value           // stores *scheduledPauseInfo, updated on ApplyConfig
	familyTime    atomic.Value           // stores *familyTimeInfo, updated on ApplyConfig
}

type PauseInfo struct {
	Paused bool
	Until  time.Time
}

// NewManager creates a blocklist manager. Optional logAttrs (key-value pairs, e.g. "group_id", "kids")
// are included in logs to disambiguate global vs per-group blocklists when multiple managers log in rapid succession.
func NewManager(cfg config.BlocklistConfig, logger *slog.Logger, logAttrs ...any) *Manager {
	manager := &Manager{
		sources:         cfg.Sources,
		refreshInterval: cfg.RefreshInterval.Duration,
		client: &http.Client{
			Timeout: 15 * time.Second,
		},
		logger:         logger,
		logAttrs:       logAttrs,
		allowMatcher:   normalizeList(cfg.Allowlist, logger),
		denyMatcher:    normalizeList(cfg.Denylist, logger),
		lastAppliedCfg: ptr(blocklistConfigCopy(cfg)),
	}
	manager.snapshot.Store(&Snapshot{
		blocked: map[string]struct{}{},
		allow:   manager.allowMatcher,
		deny:    manager.denyMatcher,
	})
	return manager
}

// scheduledPauseInfo holds parsed schedule for quick lookup.
type scheduledPauseInfo struct {
	enabled bool
	startH  int
	startM  int
	endH    int
	endM    int
	days    map[int]struct{} // 0=Sun..6=Sat; nil = all days
}

func parseScheduledPause(cfg *config.ScheduledPauseConfig) *scheduledPauseInfo {
	if cfg == nil || cfg.Enabled == nil || !*cfg.Enabled {
		return nil
	}
	var sh, sm, eh, em int
	if _, err := fmt.Sscanf(strings.TrimSpace(cfg.Start), "%d:%d", &sh, &sm); err != nil {
		return nil
	}
	if _, err := fmt.Sscanf(strings.TrimSpace(cfg.End), "%d:%d", &eh, &em); err != nil {
		return nil
	}
	info := &scheduledPauseInfo{
		enabled: true,
		startH:  sh,
		startM:  sm,
		endH:    eh,
		endM:    em,
	}
	if len(cfg.Days) > 0 {
		info.days = make(map[int]struct{})
		for _, d := range cfg.Days {
			info.days[d] = struct{}{}
		}
	}
	return info
}

func (s *scheduledPauseInfo) inWindow(now time.Time) bool {
	if s == nil || !s.enabled {
		return false
	}
	if s.days != nil {
		weekday := int(now.Weekday()) // 0=Sun, 1=Mon, ...
		if _, ok := s.days[weekday]; !ok {
			return false
		}
	}
	nowMin := now.Hour()*60 + now.Minute()
	startMin := s.startH*60 + s.startM
	endMin := s.endH*60 + s.endM
	return nowMin >= startMin && nowMin < endMin
}

// familyTimeInfo holds parsed family time schedule and domain set.
type familyTimeInfo struct {
	enabled bool
	startH  int
	startM  int
	endH    int
	endM    int
	days    map[int]struct{} // 0=Sun..6=Sat; nil = all days
	domains *domainMatcher   // domains to block during family time
}

func parseFamilyTime(cfg *config.FamilyTimeConfig) *familyTimeInfo {
	if cfg == nil || cfg.Enabled == nil || !*cfg.Enabled {
		return nil
	}
	var sh, sm, eh, em int
	if _, err := fmt.Sscanf(strings.TrimSpace(cfg.Start), "%d:%d", &sh, &sm); err != nil {
		return nil
	}
	if _, err := fmt.Sscanf(strings.TrimSpace(cfg.End), "%d:%d", &eh, &em); err != nil {
		return nil
	}
	domains := DomainsForServices(cfg.Services)
	domains = append(domains, cfg.Domains...)
	if len(domains) == 0 {
		return nil
	}
	info := &familyTimeInfo{
		enabled: true,
		startH:  sh,
		startM:  sm,
		endH:    eh,
		endM:    em,
		domains: normalizeList(domains, nil),
	}
	if len(cfg.Days) > 0 {
		info.days = make(map[int]struct{})
		for _, d := range cfg.Days {
			info.days[d] = struct{}{}
		}
	}
	return info
}

func (f *familyTimeInfo) inWindow(now time.Time) bool {
	if f == nil || !f.enabled || f.domains == nil {
		return false
	}
	if f.days != nil {
		weekday := int(now.Weekday())
		if _, ok := f.days[weekday]; !ok {
			return false
		}
	}
	nowMin := now.Hour()*60 + now.Minute()
	startMin := f.startH*60 + f.startM
	endMin := f.endH*60 + f.endM
	return nowMin >= startMin && nowMin < endMin
}

func ptr[T any](v T) *T { return &v }

func (m *Manager) Start(ctx context.Context) {
	if m.lastAppliedCfg != nil {
		m.schedPause.Store(parseScheduledPause(m.lastAppliedCfg.ScheduledPause))
		m.familyTime.Store(parseFamilyTime(m.lastAppliedCfg.FamilyTime))
	}
	if err := m.LoadOnce(ctx); err != nil && m.logger != nil {
		m.logger.Error("blocklist initial load failed", "err", err)
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
					m.logger.Error("blocklist refresh failed", "err", err)
				}
			}
		}
	}()
}

// HealthCheckResult holds the result of validating a blocklist source URL.
type HealthCheckResult struct {
	Name   string `json:"name"`
	URL    string `json:"url"`
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
	Status int    `json:"status,omitempty"`
}

// ValidateSources checks each blocklist URL (HEAD request). Returns results and nil error if all pass.
// If healthCfg is nil or disabled, returns nil, nil.
func (m *Manager) validateSources(ctx context.Context, sources []config.BlocklistSource, healthCfg *config.BlocklistHealthCheckConfig) ([]HealthCheckResult, error) {
	if healthCfg == nil || healthCfg.Enabled == nil || !*healthCfg.Enabled {
		return nil, nil
	}
	if len(sources) == 0 {
		return nil, nil
	}

	results := make([]HealthCheckResult, 0, len(sources))
	for _, source := range sources {
		if source.URL == "" {
			continue
		}
		res := HealthCheckResult{Name: source.Name, URL: source.URL}
		// Use GET (some blocklist servers don't support HEAD); we only check status
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, source.URL, nil)
		if err != nil {
			res.OK = false
			res.Error = err.Error()
			results = append(results, res)
			if healthCfg.FailOnAny != nil && *healthCfg.FailOnAny {
				return results, fmt.Errorf("blocklist %q: %w", source.Name, err)
			}
			continue
		}
		resp, err := m.client.Do(req)
		if err != nil {
			res.OK = false
			res.Error = err.Error()
			results = append(results, res)
			if healthCfg.FailOnAny != nil && *healthCfg.FailOnAny {
				return results, fmt.Errorf("blocklist %q fetch failed: %w", source.Name, err)
			}
			continue
		}
		// Drain body (up to 64KB) to allow connection reuse
		io.CopyN(io.Discard, resp.Body, 64*1024)
		resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			res.OK = false
			res.Status = resp.StatusCode
			res.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
			results = append(results, res)
			if healthCfg.FailOnAny != nil && *healthCfg.FailOnAny {
				return results, fmt.Errorf("blocklist %q returned status %d", source.Name, resp.StatusCode)
			}
			continue
		}
		res.OK = true
		results = append(results, res)
	}
	return results, nil
}

// ValidateSources is the public API for health check; used by control server.
func (m *Manager) ValidateSources(ctx context.Context) ([]HealthCheckResult, error) {
	m.configMu.RLock()
	sources := append([]config.BlocklistSource(nil), m.sources...)
	healthCfg := m.lastAppliedCfg.HealthCheck
	m.configMu.RUnlock()
	return m.validateSources(ctx, sources, healthCfg)
}

func (m *Manager) LoadOnce(ctx context.Context) error {
	m.configMu.RLock()
	sources := append([]config.BlocklistSource(nil), m.sources...)
	allowMatcher := m.allowMatcher
	denyMatcher := m.denyMatcher
	healthCfg := m.lastAppliedCfg.HealthCheck
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
	// Health check: validate URLs before fetching (when enabled)
	if healthCfg != nil && healthCfg.Enabled != nil && *healthCfg.Enabled {
		results, err := m.validateSources(ctx, sources, healthCfg)
		if err != nil {
			return err
		}
		for _, r := range results {
			if !r.OK && r.Error != "" {
				m.logf(slog.LevelWarn, "blocklist health check", "source", r.Name, "error", r.Error)
			}
		}
	}
	blocked := make(map[string]struct{})
	failures := 0
	emptySources := 0
	sourceCounts := make([]string, 0, len(sources))
	for _, source := range sources {
		if source.URL == "" {
			continue
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, source.URL, nil)
		if err != nil {
			failures++
			m.logf(slog.LevelError, "blocklist source request failed", "source", source.Name, "err", err)
			continue
		}
		resp, err := m.client.Do(req)
		if err != nil {
			failures++
			m.logf(slog.LevelError, "blocklist source fetch failed", "source", source.Name, "err", err)
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			failures++
			m.logf(slog.LevelWarn, "blocklist source returned non-2xx", "source", source.Name, "status", resp.StatusCode)
			continue
		}
		entries, err := ParseDomains(resp.Body)
		resp.Body.Close()
		if err != nil {
			failures++
			m.logf(slog.LevelError, "blocklist source parse failed", "source", source.Name, "err", err)
			continue
		}
		if len(entries) == 0 {
			emptySources++
			m.logf(slog.LevelWarn, "blocklist source returned no domains", "source", source.Name, "hint", "source may have returned error page or empty content; reapply to retry")
		}
		sourceCounts = append(sourceCounts, source.Name+":"+fmt.Sprintf("%d", len(entries)))
		for domain := range entries {
			blocked[domain] = struct{}{}
		}
	}
	if failures == len(sources) {
		return fmt.Errorf("all blocklist sources failed")
	}
	if (failures > 0 || emptySources > 0) && m.logger != nil {
		m.logf(slog.LevelWarn, "blocklist partial load", "failed_sources", failures, "empty_sources", emptySources, "loaded_domains", len(blocked), "hint", "some sources failed or returned no domains; reapply blocklists or check logs")
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
			args := []any{"domains", len(blocked), "fill_ratio_pct", stats.FillRatio*100, "estimated_fpr", stats.EstimatedFPR}
			if len(sourceCounts) > 0 {
				args = append(args, "sources", strings.Join(sourceCounts, ","))
			}
			if len(m.logAttrs) > 0 {
				args = append(args, m.logAttrs...)
			}
			m.logger.Info("blocklist bloom filter", args...)
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
	// Skip expensive reload if blocklist config is unchanged.
	// Each LoadOnce allocates ~100MB+ (parsed domains, bloom filter); repeated
	// reloads (e.g. from /blocklists/reload without config changes) caused memory growth.
	if m.lastAppliedCfg != nil && blocklistConfigEqual(*m.lastAppliedCfg, cfg) {
		m.configMu.Unlock()
		return nil
	}
	m.sources = cfg.Sources
	m.refreshInterval = cfg.RefreshInterval.Duration
	m.allowMatcher = normalizeList(cfg.Allowlist, m.logger)
	m.denyMatcher = normalizeList(cfg.Denylist, m.logger)
	cfgCopy := blocklistConfigCopy(cfg)
	m.lastAppliedCfg = &cfgCopy
	m.schedPause.Store(parseScheduledPause(cfg.ScheduledPause))
	m.familyTime.Store(parseFamilyTime(cfg.FamilyTime))
	m.configMu.Unlock()

	return m.LoadOnce(ctx)
}

func blocklistConfigCopy(cfg config.BlocklistConfig) config.BlocklistConfig {
	c := config.BlocklistConfig{
		RefreshInterval: cfg.RefreshInterval,
		Sources:         append([]config.BlocklistSource(nil), cfg.Sources...),
		Allowlist:       append([]string(nil), cfg.Allowlist...),
		Denylist:        append([]string(nil), cfg.Denylist...),
		ScheduledPause:  cfg.ScheduledPause,
		FamilyTime:      cfg.FamilyTime,
		HealthCheck:     cfg.HealthCheck,
	}
	return c
}

func blocklistConfigEqual(a, b config.BlocklistConfig) bool {
	if a.RefreshInterval != b.RefreshInterval {
		return false
	}
	if len(a.Sources) != len(b.Sources) {
		return false
	}
	for i := range a.Sources {
		if a.Sources[i].Name != b.Sources[i].Name || a.Sources[i].URL != b.Sources[i].URL {
			return false
		}
	}
	if !scheduledPauseEqual(a.ScheduledPause, b.ScheduledPause) {
		return false
	}
	if !familyTimeEqual(a.FamilyTime, b.FamilyTime) {
		return false
	}
	if !healthCheckEqual(a.HealthCheck, b.HealthCheck) {
		return false
	}
	return stringSlicesEqual(a.Allowlist, b.Allowlist) && stringSlicesEqual(a.Denylist, b.Denylist)
}

func scheduledPauseEqual(a, b *config.ScheduledPauseConfig) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	ae := a.Enabled != nil && *a.Enabled
	be := b.Enabled != nil && *b.Enabled
	if ae != be {
		return false
	}
	if a.Start != b.Start || a.End != b.End {
		return false
	}
	if len(a.Days) != len(b.Days) {
		return false
	}
	am := make(map[int]struct{}, len(a.Days))
	for _, d := range a.Days {
		am[d] = struct{}{}
	}
	for _, d := range b.Days {
		if _, ok := am[d]; !ok {
			return false
		}
	}
	return true
}

func familyTimeEqual(a, b *config.FamilyTimeConfig) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	ae := a.Enabled != nil && *a.Enabled
	be := b.Enabled != nil && *b.Enabled
	if ae != be {
		return false
	}
	if a.Start != b.Start || a.End != b.End {
		return false
	}
	if len(a.Days) != len(b.Days) {
		return false
	}
	am := make(map[int]struct{}, len(a.Days))
	for _, d := range a.Days {
		am[d] = struct{}{}
	}
	for _, d := range b.Days {
		if _, ok := am[d]; !ok {
			return false
		}
	}
	return stringSlicesEqual(a.Services, b.Services) && stringSlicesEqual(a.Domains, b.Domains)
}

func healthCheckEqual(a, b *config.BlocklistHealthCheckConfig) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	ae := a.Enabled != nil && *a.Enabled
	be := b.Enabled != nil && *b.Enabled
	if ae != be {
		return false
	}
	af := a.FailOnAny != nil && *a.FailOnAny
	bf := b.FailOnAny != nil && *b.FailOnAny
	return af == bf
}

func stringSlicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	am := make(map[string]struct{}, len(a))
	for _, s := range a {
		am[s] = struct{}{}
	}
	for _, s := range b {
		if _, ok := am[s]; !ok {
			return false
		}
	}
	return true
}

func (m *Manager) IsBlocked(qname string) bool {
	normalized := normalizeQueryName(qname)
	if normalized == "" {
		return false
	}

	// Family time: block specified services during scheduled window
	ft := m.familyTime.Load()
	if ft != nil {
		fi := ft.(*familyTimeInfo)
		if fi != nil && fi.inWindow(time.Now()) && domainMatch(fi.domains, normalized) {
			return true
		}
	}

	// Check if blocking is paused (scheduled pause or manual pause)
	if m.IsPaused() {
		return false
	}

	snap := m.snapshot.Load()
	if snap == nil {
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
	// Manual pause (with duration)
	info := m.pauseInfo.Load()
	if info != nil {
		pauseInfo := info.(*PauseInfo)
		if pauseInfo.Paused && time.Now().Before(pauseInfo.Until) {
			return true
		}
		if pauseInfo.Paused && time.Now().After(pauseInfo.Until) {
			m.Resume()
		}
	}
	// Scheduled pause (e.g. work hours)
	sched := m.schedPause.Load()
	if sched != nil {
		sp := sched.(*scheduledPauseInfo)
		if sp != nil && sp.inWindow(time.Now()) {
			return true
		}
	}
	return false
}

func (m *Manager) PauseStatus() PauseInfo {
	// Manual pause
	info := m.pauseInfo.Load()
	if info != nil {
		pauseInfo := info.(*PauseInfo)
		if pauseInfo.Paused && time.Now().After(pauseInfo.Until) {
			m.Resume()
		}
		if pauseInfo.Paused && time.Now().Before(pauseInfo.Until) {
			return *pauseInfo
		}
	}
	// Scheduled pause: report as paused if in window (no Until for schedule)
	sched := m.schedPause.Load()
	if sched != nil {
		sp := sched.(*scheduledPauseInfo)
		if sp != nil && sp.inWindow(time.Now()) {
			return PauseInfo{Paused: true, Until: time.Time{}} // Until empty = scheduled
		}
	}
	return PauseInfo{Paused: false}
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

func normalizeList(domains []string, logger *slog.Logger) *domainMatcher {
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
					logger.Error("invalid regex pattern", "pattern", trimmed, "err", err)
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

func (m *Manager) logf(level slog.Level, msg string, args ...any) {
	if m.logger == nil {
		return
	}
	m.logger.Log(nil, level, msg, args...)
}
