package control

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/dnsresolver"
)

// handleClientGroupsCRUD returns handler for GET/POST /client-groups (Phase 6).
func handleClientGroupsCRUD(resolver *dnsresolver.Resolver, configPath, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if configPath == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "config path not set"})
			return
		}
		switch r.Method {
		case http.MethodGet:
			handleClientGroupsList(w, configPath)
		case http.MethodPost:
			handleClientGroupsCreateOrUpdate(w, r, resolver, configPath)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}

// handleClientGroupsDeleteHandler returns handler for DELETE /client-groups/{id} (Phase 6).
func handleClientGroupsDeleteHandler(resolver *dnsresolver.Resolver, configPath, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if token != "" && !authorize(token, r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if configPath == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "config path not set"})
			return
		}
		if r.Method != http.MethodDelete {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		handleClientGroupsDelete(w, r, resolver, configPath)
	}
}

func handleClientGroupsList(w http.ResponseWriter, configPath string) {
	cfg, err := config.Load(configPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	groups := make([]map[string]any, 0, len(cfg.ClientGroups))
	for _, g := range cfg.ClientGroups {
		grp := map[string]any{"id": g.ID, "name": g.Name, "description": g.Description}
		if g.Blocklist != nil {
			grp["blocklist"] = groupBlocklistToMap(g.Blocklist)
		}
		if g.SafeSearch != nil {
			grp["safe_search"] = map[string]any{
				"enabled": g.SafeSearch.Enabled,
				"google":  g.SafeSearch.Google,
				"bing":    g.SafeSearch.Bing,
			}
		}
		groups = append(groups, grp)
	}
	writeJSON(w, http.StatusOK, map[string]any{"client_groups": groups})
}

func groupBlocklistToMap(bl *config.GroupBlocklistConfig) map[string]any {
	m := map[string]any{}
	if bl.InheritGlobal != nil {
		m["inherit_global"] = *bl.InheritGlobal
	}
	if len(bl.Sources) > 0 {
		m["sources"] = bl.Sources
	}
	if len(bl.Allowlist) > 0 {
		m["allowlist"] = bl.Allowlist
	}
	if len(bl.Denylist) > 0 {
		m["denylist"] = bl.Denylist
	}
	if bl.ScheduledPause != nil {
		m["scheduled_pause"] = bl.ScheduledPause
	}
	return m
}

func handleClientGroupsCreateOrUpdate(w http.ResponseWriter, r *http.Request, resolver *dnsresolver.Resolver, configPath string) {
	var body struct {
		ID          string                 `json:"id"`
		Name        string                 `json:"name"`
		Description string                 `json:"description"`
		Blocklist   map[string]any         `json:"blocklist"`
		SafeSearch  map[string]any         `json:"safe_search"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON: " + err.Error()})
		return
	}
	body.ID = strings.TrimSpace(body.ID)
	body.Name = strings.TrimSpace(body.Name)
	body.Description = strings.TrimSpace(body.Description)
	if body.ID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "id is required"})
		return
	}
	if body.Name == "" {
		body.Name = body.ID
	}
	override, err := config.ReadOverrideMap(configPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	rawGroups, _ := override["client_groups"].([]any)
	if rawGroups == nil {
		rawGroups = []any{}
	}
	groups := make([]map[string]any, 0, len(rawGroups)+1)
	found := false
	for _, g := range rawGroups {
		m, ok := g.(map[string]any)
		if !ok {
			continue
		}
		id, _ := m["id"].(string)
		if id == body.ID {
			groups = append(groups, buildGroupMap(body.ID, body.Name, body.Description, body.Blocklist, body.SafeSearch))
			found = true
		} else {
			groups = append(groups, m)
		}
	}
	if !found {
		groups = append(groups, buildGroupMap(body.ID, body.Name, body.Description, body.Blocklist, body.SafeSearch))
	}
	override["client_groups"] = groups
	if err := config.WriteOverrideMap(configPath, override); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	reloadClientGroups(w, resolver, configPath)
}

func buildGroupMap(id, name, desc string, blocklist, safeSearch map[string]any) map[string]any {
	m := map[string]any{"id": id, "name": name, "description": desc}
	if len(blocklist) > 0 {
		m["blocklist"] = blocklist
	}
	if len(safeSearch) > 0 {
		m["safe_search"] = safeSearch
	}
	return m
}

func handleClientGroupsDelete(w http.ResponseWriter, r *http.Request, resolver *dnsresolver.Resolver, configPath string) {
	suffix := strings.TrimPrefix(r.URL.Path, "/client-groups/")
	suffix = strings.TrimPrefix(suffix, "/")
	id, err := url.PathUnescape(suffix)
	if err != nil {
		id = suffix
	}
	id = strings.TrimSpace(id)
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "group id required (e.g. /client-groups/kids)"})
		return
	}
	if id == "default" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "cannot delete the default group"})
		return
	}
	override, err := config.ReadOverrideMap(configPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	rawGroups, _ := override["client_groups"].([]any)
	if rawGroups == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	groups := make([]map[string]any, 0, len(rawGroups))
	for _, g := range rawGroups {
		m, ok := g.(map[string]any)
		if !ok {
			continue
		}
		if grpID, _ := m["id"].(string); grpID != id {
			groups = append(groups, m)
		}
	}
	override["client_groups"] = groups
	if err := config.WriteOverrideMap(configPath, override); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	reloadClientGroups(w, resolver, configPath)
}

func reloadClientGroups(w http.ResponseWriter, resolver *dnsresolver.Resolver, configPath string) {
	cfg, err := config.Load(configPath)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "warning": "saved but reload failed: " + err.Error()})
		return
	}
	if resolver != nil {
		resolver.ApplyClientIdentificationConfig(cfg)
		resolver.ApplyBlocklistConfig(context.Background(), cfg)
		resolver.ApplySafeSearchConfig(cfg)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
