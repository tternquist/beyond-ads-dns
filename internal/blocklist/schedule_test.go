package blocklist

import (
	"testing"
	"time"

	"github.com/tternquist/beyond-ads-dns/internal/config"
)

func TestMinutesInWindow(t *testing.T) {
	tests := []struct {
		name            string
		now, start, end int
		want            bool
	}{
		{"daytime inside", 10 * 60, 9 * 60, 17 * 60, true},
		{"daytime before", 8 * 60, 9 * 60, 17 * 60, false},
		{"daytime at end", 17 * 60, 9 * 60, 17 * 60, false},
		{"overnight late evening", 23 * 60, 22 * 60, 6 * 60, true},
		{"overnight early morning", 5 * 60, 22 * 60, 6 * 60, true},
		{"overnight midday", 12 * 60, 22 * 60, 6 * 60, false},
		{"overnight at start", 22 * 60, 22 * 60, 6 * 60, true},
		{"overnight at end", 6 * 60, 22 * 60, 6 * 60, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := minutesInWindow(tt.now, tt.start, tt.end); got != tt.want {
				t.Errorf("minutesInWindow(%d, %d, %d) = %v, want %v", tt.now, tt.start, tt.end, got, tt.want)
			}
		})
	}
}

func TestScheduledPauseOvernightWindow(t *testing.T) {
	info := parseScheduledPause(&config.ScheduledPauseConfig{
		Enabled: ptr(true),
		Start:   "22:00",
		End:     "06:00",
	})
	if info == nil {
		t.Fatal("expected parsed scheduled pause")
	}
	at := func(hour int) time.Time {
		return time.Date(2026, 6, 12, hour, 0, 0, 0, time.Local)
	}
	if !info.inWindow(at(23)) {
		t.Error("23:00 should be inside 22:00–06:00")
	}
	if !info.inWindow(at(2)) {
		t.Error("02:00 should be inside 22:00–06:00")
	}
	if info.inWindow(at(12)) {
		t.Error("12:00 should be outside 22:00–06:00")
	}
}

func TestFamilyTimeOvernightWindow(t *testing.T) {
	info := parseFamilyTime(&config.FamilyTimeConfig{
		Enabled:  ptr(true),
		Start:    "21:30",
		End:      "07:00",
		Services: []string{"youtube"},
	})
	if info == nil {
		t.Fatal("expected parsed family time")
	}
	at := func(hour, minute int) time.Time {
		return time.Date(2026, 6, 12, hour, minute, 0, 0, time.Local)
	}
	if !info.inWindow(at(22, 0)) {
		t.Error("22:00 should be inside 21:30–07:00")
	}
	if !info.inWindow(at(6, 30)) {
		t.Error("06:30 should be inside 21:30–07:00")
	}
	if info.inWindow(at(8, 0)) {
		t.Error("08:00 should be outside 21:30–07:00")
	}
}
