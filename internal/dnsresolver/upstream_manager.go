package dnsresolver

import (
	"sync"
	"sync/atomic"
	"time"
)

// upstreamManager manages upstream server selection, backoff, and weighted latency tracking.
// It encapsulates upstream-related state that was previously scattered across the Resolver struct.
type upstreamManager struct {
	mu       sync.RWMutex
	servers  []Upstream
	strategy string
	timeout  time.Duration

	backoff     time.Duration
	backoffMu   sync.RWMutex
	backoffUntil map[string]time.Time

	connPoolIdleTimeout         time.Duration
	connPoolValidateBeforeReuse bool

	// load_balance: round-robin counter
	loadBalanceNext uint64

	// weighted: per-upstream EWMA of response time (ms)
	weightedLatency   map[string]*float64
	weightedLatencyMu sync.RWMutex
}

func newUpstreamManager(upstreams []Upstream, strategy string, timeout, backoff time.Duration, connPoolIdle time.Duration, connPoolValidate bool) *upstreamManager {
	m := &upstreamManager{
		servers:                     upstreams,
		strategy:                    strategy,
		timeout:                     timeout,
		backoff:                     backoff,
		backoffUntil:                make(map[string]time.Time),
		connPoolIdleTimeout:         connPoolIdle,
		connPoolValidateBeforeReuse: connPoolValidate,
		weightedLatency:             make(map[string]*float64),
	}
	if strategy == StrategyWeighted {
		for _, u := range upstreams {
			init := 50.0
			m.weightedLatency[u.Address] = &init
		}
	}
	return m
}

// Upstreams returns a copy of the current upstream list and the strategy.
func (m *upstreamManager) Upstreams() ([]Upstream, string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]Upstream, len(m.servers))
	copy(result, m.servers)
	return result, m.strategy
}

// GetTimeout returns the current upstream timeout.
func (m *upstreamManager) GetTimeout() time.Duration {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.timeout <= 0 {
		return defaultUpstreamTimeout
	}
	return m.timeout
}

// GetConnPoolConfig returns connection pool settings.
func (m *upstreamManager) GetConnPoolConfig() (idleTimeout time.Duration, validateBeforeReuse bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.connPoolIdleTimeout, m.connPoolValidateBeforeReuse
}

// Order returns the order in which to try upstreams based on the current strategy.
func (m *upstreamManager) Order(upstreams []Upstream) []int {
	m.mu.RLock()
	strategy := m.strategy
	m.mu.RUnlock()

	switch strategy {
	case StrategyLoadBalance:
		n := uint64(len(upstreams))
		if n == 0 {
			return nil
		}
		next := atomic.AddUint64(&m.loadBalanceNext, 1)
		start := int(next % n)
		order := make([]int, len(upstreams))
		for i := range order {
			order[i] = (start + i) % len(upstreams)
		}
		return order
	case StrategyWeighted:
		return m.weightedOrder(upstreams)
	default:
		order := make([]int, len(upstreams))
		for i := range order {
			order[i] = i
		}
		return order
	}
}

func (m *upstreamManager) weightedOrder(upstreams []Upstream) []int {
	m.weightedLatencyMu.RLock()
	defer m.weightedLatencyMu.RUnlock()

	type scored struct {
		idx   int
		score float64
	}
	scores := make([]scored, len(upstreams))
	for i, u := range upstreams {
		lat := m.weightedLatency[u.Address]
		score := weightedMinLatencyMS
		if lat != nil && *lat > 0 {
			score = *lat
		}
		scores[i] = scored{idx: i, score: score}
	}
	for i := 0; i < len(scores)-1; i++ {
		for j := i + 1; j < len(scores); j++ {
			if scores[j].score < scores[i].score {
				scores[i], scores[j] = scores[j], scores[i]
			}
		}
	}
	order := make([]int, len(upstreams))
	for i, s := range scores {
		order[i] = s.idx
	}
	return order
}

// UpdateWeightedLatency records a new response time for the given upstream address.
func (m *upstreamManager) UpdateWeightedLatency(address string, elapsed time.Duration) {
	ms := elapsed.Seconds() * 1000
	if ms < weightedMinLatencyMS {
		ms = weightedMinLatencyMS
	}
	m.weightedLatencyMu.Lock()
	defer m.weightedLatencyMu.Unlock()
	ptr := m.weightedLatency[address]
	if ptr != nil {
		*ptr = weightedEWMAAlpha*ms + (1-weightedEWMAAlpha)*(*ptr)
	}
}

// IsInBackoff returns true if the upstream address is in backoff.
func (m *upstreamManager) IsInBackoff(addr string) bool {
	if m.backoff <= 0 {
		return false
	}
	m.backoffMu.RLock()
	defer m.backoffMu.RUnlock()
	until, ok := m.backoffUntil[addr]
	return ok && until.After(time.Now())
}

// RecordBackoff marks an upstream as in backoff.
func (m *upstreamManager) RecordBackoff(addr string) {
	m.backoffMu.Lock()
	defer m.backoffMu.Unlock()
	if m.backoffUntil == nil {
		m.backoffUntil = make(map[string]time.Time)
	}
	m.backoffUntil[addr] = time.Now().Add(m.backoff)
}

// ClearBackoff removes backoff state for an upstream.
func (m *upstreamManager) ClearBackoff(addr string) {
	m.backoffMu.Lock()
	defer m.backoffMu.Unlock()
	delete(m.backoffUntil, addr)
}

// ApplyConfig updates the upstream configuration at runtime (hot-reload).
func (m *upstreamManager) ApplyConfig(upstreams []Upstream, strategy string, timeout, backoff, connPoolIdle time.Duration, connPoolValidate bool) {
	m.mu.Lock()
	m.servers = upstreams
	m.strategy = strategy
	m.timeout = timeout
	m.backoff = backoff
	m.connPoolIdleTimeout = connPoolIdle
	m.connPoolValidateBeforeReuse = connPoolValidate
	m.mu.Unlock()

	// Clear backoff for upstreams no longer in config
	m.backoffMu.Lock()
	if m.backoffUntil != nil {
		addrSet := make(map[string]bool)
		for _, u := range upstreams {
			addrSet[u.Address] = true
		}
		for addr := range m.backoffUntil {
			if !addrSet[addr] {
				delete(m.backoffUntil, addr)
			}
		}
	}
	m.backoffMu.Unlock()

	// Update weighted latency map for new upstreams
	if strategy == StrategyWeighted {
		m.weightedLatencyMu.Lock()
		newMap := make(map[string]*float64)
		for _, u := range upstreams {
			if ptr, ok := m.weightedLatency[u.Address]; ok {
				newMap[u.Address] = ptr
			} else {
				init := 50.0
				newMap[u.Address] = &init
			}
		}
		m.weightedLatency = newMap
		m.weightedLatencyMu.Unlock()
	}
}

// BackoffEnabled returns true if upstream backoff is configured.
func (m *upstreamManager) BackoffEnabled() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.backoff > 0
}

// Strategy returns the current resolver strategy.
func (m *upstreamManager) Strategy() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.strategy
}
