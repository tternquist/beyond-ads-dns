package errorlog

import "testing"

func TestDocRefForMessage_SlogFormats(t *testing.T) {
	// slog JSON format - message is in "msg" field
	jsonLine := `{"time":"2026-02-18T12:00:00Z","level":"ERROR","msg":"sync: blocklist reload error","err":"connection refused"}`
	if got := DocRefForMessage(jsonLine); got != "sync-blocklist-reload-error" {
		t.Errorf("DocRefForMessage(slog JSON) = %q, want sync-blocklist-reload-error", got)
	}

	// slog text format - message is in msg= key
	textLine := `time=2026-02-18T12:00:00Z level=ERROR msg="sync: blocklist reload error" err=connection refused`
	if got := DocRefForMessage(textLine); got != "sync-blocklist-reload-error" {
		t.Errorf("DocRefForMessage(slog text) = %q, want sync-blocklist-reload-error", got)
	}

	// slog JSON with different error
	jsonLine2 := `{"time":"2026-02-18T12:00:00Z","level":"WARN","msg":"cache hit counter failed","err":"timeout"}`
	if got := DocRefForMessage(jsonLine2); got != "cache-hit-counter-failed" {
		t.Errorf("DocRefForMessage(slog JSON warning) = %q, want cache-hit-counter-failed", got)
	}

	// slog text with info level (no debug:/info: prefix in message)
	textLine2 := `time=2026-02-18T12:00:00Z level=INFO msg="sync: config applied successfully"`
	if got := DocRefForMessage(textLine2); got != "sync-config-applied" {
		t.Errorf("DocRefForMessage(slog text info) = %q, want sync-config-applied", got)
	}

	// slog text with blocklist bloom filter (msg= only, no info: prefix)
	bloomLine := `time=2026-02-18T12:10:53.423Z level=INFO msg="blocklist bloom filter" domains=939980 fill_ratio_pct=50.1`
	if got := DocRefForMessage(bloomLine); got != "blocklist-bloom-filter" {
		t.Errorf("DocRefForMessage(blocklist bloom filter slog) = %q, want blocklist-bloom-filter", got)
	}

	// slog text with blocklist partial load
	partialLine := `time=2026-02-20T12:12:19.000Z level=WARN msg="blocklist partial load" failed_sources=1 loaded_domains=430017`
	if got := DocRefForMessage(partialLine); got != "blocklist-partial-load" {
		t.Errorf("DocRefForMessage(blocklist partial load slog) = %q, want blocklist-partial-load", got)
	}

	// slog variants for other log types
	if got := DocRefForMessage(`level=WARN msg="blocklist source returned non-2xx" source=foo status=404`); got != "blocklist-source-status" {
		t.Errorf("blocklist source slog = %q, want blocklist-source-status", got)
	}
	if got := DocRefForMessage(`level=WARN msg="blocklist health check" source=bar`); got != "blocklist-health-check" {
		t.Errorf("blocklist health check slog = %q, want blocklist-health-check", got)
	}
	if got := DocRefForMessage(`level=WARN msg="refresh got SERVFAIL, backing off" cache_key=x`); got != "refresh-servfail-backoff" {
		t.Errorf("refresh SERVFAIL slog = %q, want refresh-servfail-backoff", got)
	}
	if got := DocRefForMessage(`level=INFO msg="set query retention" hours=168`); got != "query-retention-set" {
		t.Errorf("set query retention slog = %q, want query-retention-set", got)
	}
	if got := DocRefForMessage(`level=DEBUG msg="L0 cache cleanup" removed=5`); got != "l0-cache-cleanup" {
		t.Errorf("L0 cache cleanup slog = %q, want l0-cache-cleanup", got)
	}
	if got := DocRefForMessage(`level=DEBUG msg="refresh sweep" candidates=10 refreshed=3`); got != "refresh-sweep" {
		t.Errorf("refresh sweep slog = %q, want refresh-sweep", got)
	}
}

func TestDocRefForMessage_LegacyFormat(t *testing.T) {
	legacy := "2025/02/15 12:00:01 beyond-ads-dns sync: blocklist reload error: connection refused"
	if got := DocRefForMessage(legacy); got != "sync-blocklist-reload-error" {
		t.Errorf("DocRefForMessage(legacy) = %q, want sync-blocklist-reload-error", got)
	}
}
