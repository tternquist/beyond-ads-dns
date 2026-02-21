package dnsresolver

import (
	"testing"
	"time"
)

func TestServfailTracker_RecordAndBackoff(t *testing.T) {
	st := newServfailTracker(100*time.Millisecond, 10, 0)

	if st.InBackoff("key1") {
		t.Error("key1 should not be in backoff initially")
	}

	st.RecordBackoff("key1")
	if !st.InBackoff("key1") {
		t.Error("key1 should be in backoff after recording")
	}

	time.Sleep(150 * time.Millisecond)
	if st.InBackoff("key1") {
		t.Error("key1 backoff should have expired")
	}
}

func TestServfailTracker_Count(t *testing.T) {
	st := newServfailTracker(time.Hour, 3, 0)

	if count := st.GetCount("key1"); count != 0 {
		t.Errorf("initial count = %d, want 0", count)
	}

	st.IncrementCount("key1")
	st.IncrementCount("key1")
	if count := st.GetCount("key1"); count != 2 {
		t.Errorf("count after 2 increments = %d, want 2", count)
	}

	st.ClearCount("key1")
	if count := st.GetCount("key1"); count != 0 {
		t.Errorf("count after clear = %d, want 0", count)
	}
}

func TestServfailTracker_ExceedsThreshold(t *testing.T) {
	st := newServfailTracker(time.Hour, 3, 0)

	for i := 0; i < 3; i++ {
		if st.ExceedsThreshold("key1") {
			t.Errorf("should not exceed threshold at count %d", i)
		}
		st.IncrementCount("key1")
	}
	if !st.ExceedsThreshold("key1") {
		t.Error("should exceed threshold at count 3")
	}
}

func TestServfailTracker_ExceedsThreshold_Disabled(t *testing.T) {
	st := newServfailTracker(time.Hour, 0, 0)

	for i := 0; i < 100; i++ {
		st.IncrementCount("key1")
	}
	if st.ExceedsThreshold("key1") {
		t.Error("ExceedsThreshold should always return false when threshold is 0")
	}
}

func TestServfailTracker_ShouldLog_NoRateLimit(t *testing.T) {
	st := newServfailTracker(time.Hour, 10, 0)

	for i := 0; i < 5; i++ {
		if !st.ShouldLog("key1") {
			t.Errorf("ShouldLog should always return true when logInterval is 0 (iteration %d)", i)
		}
	}
}

func TestServfailTracker_ShouldLog_RateLimited(t *testing.T) {
	st := newServfailTracker(time.Hour, 10, 100*time.Millisecond)

	if !st.ShouldLog("key1") {
		t.Error("first ShouldLog should return true")
	}
	if st.ShouldLog("key1") {
		t.Error("second ShouldLog within interval should return false")
	}

	time.Sleep(150 * time.Millisecond)
	if !st.ShouldLog("key1") {
		t.Error("ShouldLog after interval should return true")
	}
}

func TestServfailTracker_PruneExpired(t *testing.T) {
	st := newServfailTracker(50*time.Millisecond, 10, 0)

	for i := 0; i < 5; i++ {
		key := "key" + string(rune('0'+i))
		st.RecordBackoff(key)
		st.IncrementCount(key)
	}
	if st.Size() != 5 {
		t.Errorf("size = %d, want 5", st.Size())
	}

	time.Sleep(100 * time.Millisecond)
	st.PruneExpired()
	if st.Size() != 0 {
		t.Errorf("size after prune = %d, want 0", st.Size())
	}
}

func TestServfailTracker_BoundedGrowth(t *testing.T) {
	st := newServfailTracker(time.Hour, 10, 0)

	for i := 0; i < servfailMaxEntries+100; i++ {
		key := "key" + string(rune(i))
		st.RecordBackoff(key)
	}

	if st.Size() > servfailMaxEntries {
		t.Errorf("size = %d, exceeds max %d", st.Size(), servfailMaxEntries)
	}
}

func TestServfailTracker_PruneCleansCounts(t *testing.T) {
	st := newServfailTracker(50*time.Millisecond, 10, 0)

	st.RecordBackoff("key1")
	st.IncrementCount("key1")
	st.IncrementCount("key1")

	if count := st.GetCount("key1"); count != 2 {
		t.Errorf("count = %d, want 2", count)
	}

	time.Sleep(100 * time.Millisecond)
	st.PruneExpired()

	if count := st.GetCount("key1"); count != 0 {
		t.Errorf("count after prune = %d, want 0 (should be cleaned with expired backoff)", count)
	}
}
