package metrics

import (
	"testing"
)

func TestInit(t *testing.T) {
	reg := Init()
	if reg == nil {
		t.Fatal("Init returned nil registry")
	}
	// Second call should return same registry (sync.Once)
	reg2 := Init()
	if reg != reg2 {
		t.Error("Init should return same registry on subsequent calls")
	}
}

func TestRegistry_BeforeInit(t *testing.T) {
	// Registry is nil until Init is called. In a fresh test process we might have
	// already called Init from another test. So we just verify Registry doesn't panic.
	_ = Registry()
}

func TestRegistry_AfterInit(t *testing.T) {
	reg := Init()
	if Registry() != reg {
		t.Error("Registry should return the registry from Init")
	}
}

func TestRecordCacheHit(t *testing.T) {
	Init()
	// Should not panic
	RecordCacheHit(true)
	RecordCacheHit(false)
}

func TestRecordCacheMiss(t *testing.T) {
	Init()
	RecordCacheMiss()
}

func TestRecordBlocked(t *testing.T) {
	Init()
	RecordBlocked()
}

func TestRecordRefreshSweep(t *testing.T) {
	Init()
	RecordRefreshSweep(0)  // n <= 0 should not add
	RecordRefreshSweep(5)
	RecordRefreshSweep(100)
}

func TestRecordQuerystoreRecorded(t *testing.T) {
	Init()
	RecordQuerystoreRecorded()
}

func TestRecordQuerystoreDropped(t *testing.T) {
	Init()
	RecordQuerystoreDropped()
}

func TestUpdateGauges_NilProvider(t *testing.T) {
	Init()
	// Should not panic
	UpdateGauges(nil)
}

func TestUpdateGauges_WithProvider(t *testing.T) {
	Init()
	provider := &mockStatsProvider{
		hitRate:            0.5,
		l0Entries:          100,
		refreshLastSweep:   50,
		querystoreBuffer:   25,
	}
	UpdateGauges(provider)
}

type mockStatsProvider struct {
	hitRate            float64
	l0Entries          int
	refreshLastSweep   int
	querystoreBuffer   int
}

func (m *mockStatsProvider) CacheHitRate() float64       { return m.hitRate }
func (m *mockStatsProvider) L0Entries() int             { return m.l0Entries }
func (m *mockStatsProvider) RefreshLastSweepCount() int { return m.refreshLastSweep }
func (m *mockStatsProvider) QuerystoreBufferUsed() int  { return m.querystoreBuffer }
