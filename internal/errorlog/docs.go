package errorlog

import "strings"

// DocRefForMessage returns the documentation reference (anchor) for a known error message.
// Returns empty string if the error is not documented.
// Matches are done by substring (case-insensitive) in the message.
func DocRefForMessage(message string) string {
	lower := strings.ToLower(message)
	// Order matters: more specific patterns first
	patterns := []struct {
		substr string
		ref    string
	}{
		{"sync: initial pull error", "sync-pull-error"},
		{"sync: pull error (will retry)", "sync-pull-error"},
		{"sync: blocklist reload error", "sync-blocklist-reload-error"},
		{"sync: local records reload error", "sync-local-records-reload-error"},
		{"sync: stats marshal error", "sync-stats-error"},
		{"sync: stats request error", "sync-stats-error"},
		{"sync: stats push error", "sync-stats-error"},
		{"sync: stats push returned", "sync-stats-error"},
		{"sync: fetch summary error", "sync-stats-source-fetch-error"},
		{"sync: fetch latency error", "sync-stats-source-fetch-error"},
		{"sync: stats_source_url fetch returned", "sync-stats-source-fetch-error"},
		{"sync: stats_source_url summary decode error", "sync-stats-source-fetch-error"},
		{"sync: stats_source_url latency decode error", "sync-stats-source-fetch-error"},
		{"sync: error - could not update token last_used", "sync-token-update-error"},
		{"upstream exchange failed", "upstream-exchange-failed"},
		{"cache get failed", "cache-get-failed"},
		{"cache set failed", "cache-set-failed"},
		{"cache hit counter failed", "cache-hit-counter-failed"},
		{"sweep hit counter failed", "sweep-hit-counter-failed"},
		{"servfail backoff active", "servfail-backoff-active"},
		{"refresh upstream failed", "refresh-upstream-failed"},
		{"refresh got SERVFAIL for", "refresh-servfail-backoff"},
		{"refresh cache set failed", "refresh-cache-set-failed"},
		{"refresh lock failed", "refresh-lock-failed"},
		{"refresh sweep failed", "refresh-sweep-failed"},
		{"refresh sweep exists failed", "refresh-sweep-failed"},
		{"refresh sweep window hits failed", "refresh-sweep-failed"},
		{"blocklist initial load failed", "blocklist-load-failed"},
		{"blocklist refresh failed", "blocklist-refresh-failed"},
		{"invalid regex pattern", "invalid-regex-pattern"},
		{"local record ", "local-record-error"},
		{"DoT server error", "dot-server-error"},
		{"DoH server: failed to load TLS cert", "doh-server-error"},
		{"DoH server error", "doh-server-error"},
		{"control server error", "control-server-error"},
		{"server error:", "control-server-error"},
		{"failed to write local record response", "write-response-failed"},
		{"failed to write safe search response", "write-response-failed"},
		{"failed to write blocked response", "write-response-failed"},
		{"failed to write cached response", "write-response-failed"},
		{"failed to write servfail response", "write-response-failed"},
		{"failed to write upstream response", "write-response-failed"},
	}
	for _, p := range patterns {
		if strings.Contains(lower, p.substr) {
			return p.ref
		}
	}
	return ""
}
