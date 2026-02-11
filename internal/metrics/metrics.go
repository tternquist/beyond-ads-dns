package metrics

import (
	"sync"

	"github.com/prometheus/client_golang/prometheus"
)

var (
	registry *prometheus.Registry
	initOnce sync.Once
)

// Prometheus metrics for Beyond Ads DNS
var (
	CacheHitsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "dns_cache_hits_total",
		Help: "Total number of cache hits (L0 + L1)",
	})

	CacheMissesTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "dns_cache_misses_total",
		Help: "Total number of cache misses",
	})

	L0HitsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "dns_l0_hits_total",
		Help: "Total number of L0 (in-memory LRU) cache hits",
	})

	L1HitsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "dns_l1_hits_total",
		Help: "Total number of L1 (Redis) cache hits",
	})

	BlockedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "dns_queries_blocked_total",
		Help: "Total number of queries blocked by blocklist or denylist",
	})

	RefreshSweepTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "dns_refresh_sweep_total",
		Help: "Total number of keys refreshed by the sweeper",
	})

	QuerystoreRecordedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "dns_querystore_recorded_total",
		Help: "Total number of query events recorded to the store buffer",
	})

	QuerystoreDroppedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "dns_querystore_dropped_total",
		Help: "Total number of query events dropped due to full buffer",
	})

	// Gauges set from stats on scrape
	CacheHitRate = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "dns_cache_hit_rate",
		Help: "Cache hit rate (0-100)",
	})

	L0Entries = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "dns_l0_entries",
		Help: "Current number of entries in L0 (in-memory) cache",
	})

	RefreshLastSweepCount = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "dns_refresh_last_sweep_count",
		Help: "Number of keys refreshed in the last sweep",
	})

	QuerystoreBufferUsed = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "dns_querystore_buffer_used",
		Help: "Number of queries pending in the buffer",
	})
)

// StatsProvider provides current stats for gauge metrics
type StatsProvider interface {
	CacheHitRate() float64
	L0Entries() int
	RefreshLastSweepCount() int
	QuerystoreBufferUsed() int
}

// Init registers all metrics with a new registry and returns the registry.
// Safe to call multiple times; only the first call registers.
func Init() *prometheus.Registry {
	initOnce.Do(func() {
		registry = prometheus.NewRegistry()
		registry.MustRegister(
			CacheHitsTotal,
			CacheMissesTotal,
			L0HitsTotal,
			L1HitsTotal,
			BlockedTotal,
			RefreshSweepTotal,
			QuerystoreRecordedTotal,
			QuerystoreDroppedTotal,
			CacheHitRate,
			L0Entries,
			RefreshLastSweepCount,
			QuerystoreBufferUsed,
			prometheus.NewGoCollector(),
		)
	})
	return registry
}

// Registry returns the metrics registry (nil until Init is called)
func Registry() *prometheus.Registry {
	return registry
}

// RecordCacheHit increments the total cache hits counter.
// l0Hit is true when the hit came from L0 (in-memory), false when from L1 (Redis).
func RecordCacheHit(l0Hit bool) {
	CacheHitsTotal.Inc()
	if l0Hit {
		L0HitsTotal.Inc()
	} else {
		L1HitsTotal.Inc()
	}
}

// RecordCacheMiss increments the cache misses counter
func RecordCacheMiss() {
	CacheMissesTotal.Inc()
}

// RecordBlocked increments the blocked queries counter
func RecordBlocked() {
	BlockedTotal.Inc()
}

// RecordRefreshSweep adds n to the refresh sweep counter
func RecordRefreshSweep(n int) {
	if n > 0 {
		RefreshSweepTotal.Add(float64(n))
	}
}

// RecordQuerystoreRecorded increments the recorded events counter
func RecordQuerystoreRecorded() {
	QuerystoreRecordedTotal.Inc()
}

// RecordQuerystoreDropped increments the dropped events counter
func RecordQuerystoreDropped() {
	QuerystoreDroppedTotal.Inc()
}

// UpdateGauges updates gauge metrics from the provided stats
func UpdateGauges(p StatsProvider) {
	if p == nil {
		return
	}
	CacheHitRate.Set(p.CacheHitRate())
	L0Entries.Set(float64(p.L0Entries()))
	RefreshLastSweepCount.Set(float64(p.RefreshLastSweepCount()))
	QuerystoreBufferUsed.Set(float64(p.QuerystoreBufferUsed()))
}
