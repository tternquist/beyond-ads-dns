package control

import (
	"net/http"

	"github.com/tternquist/beyond-ads-dns/internal/config"
)

// loadConfigForReload loads config from the given path. If loading fails, it writes
// a consistent JSON error response to w and returns (config.Config{}, false). On success,
// returns (cfg, true). This centralizes config loading and error handling for
// all reload endpoints.
func loadConfigForReload(w http.ResponseWriter, configPath string) (config.Config, bool) {
	cfg, err := config.Load(configPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return config.Config{}, false
	}
	return cfg, true
}
