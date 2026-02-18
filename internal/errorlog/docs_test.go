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
}

func TestDocRefForMessage_LegacyFormat(t *testing.T) {
	legacy := "2025/02/15 12:00:01 beyond-ads-dns sync: blocklist reload error: connection refused"
	if got := DocRefForMessage(legacy); got != "sync-blocklist-reload-error" {
		t.Errorf("DocRefForMessage(legacy) = %q, want sync-blocklist-reload-error", got)
	}
}
