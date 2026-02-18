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

// handleClientsCRUD returns handler for GET/POST /clients (Phase 6).
func handleClientsCRUD(resolver *dnsresolver.Resolver, configPath, token string) http.HandlerFunc {
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
			handleClientsList(w, configPath)
		case http.MethodPost:
			handleClientsCreateOrUpdate(w, r, resolver, configPath)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}

// handleClientsDeleteHandler returns handler for DELETE /clients/{ip} (Phase 6).
func handleClientsDeleteHandler(resolver *dnsresolver.Resolver, configPath, token string) http.HandlerFunc {
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
		handleClientsDelete(w, r, resolver, configPath)
	}
}

func handleClientsList(w http.ResponseWriter, configPath string) {
	cfg, err := config.Load(configPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	clients := make([]map[string]any, 0, len(cfg.ClientIdentification.Clients))
	for _, e := range cfg.ClientIdentification.Clients {
		clients = append(clients, map[string]any{"ip": e.IP, "name": e.Name, "group_id": e.GroupID})
	}
	writeJSON(w, http.StatusOK, map[string]any{"clients": clients})
}

func handleClientsCreateOrUpdate(w http.ResponseWriter, r *http.Request, resolver *dnsresolver.Resolver, configPath string) {
	var body struct {
		IP      string `json:"ip"`
		Name    string `json:"name"`
		GroupID string `json:"group_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON: " + err.Error()})
		return
	}
	body.IP = strings.TrimSpace(body.IP)
	body.Name = strings.TrimSpace(body.Name)
	body.GroupID = strings.TrimSpace(body.GroupID)
	if body.IP == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "ip is required"})
		return
	}
	override, err := config.ReadOverrideMap(configPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	ci, _ := override["client_identification"].(map[string]any)
	if ci == nil {
		ci = map[string]any{"enabled": true, "clients": []any{}}
		override["client_identification"] = ci
	}
	clients := normalizeClientsToList(ci["clients"])
	found := false
	for i, c := range clients {
		if getClientIP(c) == body.IP {
			clients[i] = map[string]any{"ip": body.IP, "name": body.Name, "group_id": body.GroupID}
			found = true
			break
		}
	}
	if !found {
		clients = append(clients, map[string]any{"ip": body.IP, "name": body.Name, "group_id": body.GroupID})
	}
	ci["clients"] = clients
	if err := config.WriteOverrideMap(configPath, override); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	reloadClientIdentification(w, resolver, configPath)
}

func getClientIP(m map[string]any) string {
	if ip, ok := m["ip"].(string); ok && ip != "" {
		return ip
	}
	return ""
}

// normalizeClientsToList converts clients from legacy map or list format to list of map[string]any.
func normalizeClientsToList(raw any) []map[string]any {
	if raw == nil {
		return []map[string]any{}
	}
	if list, ok := raw.([]any); ok {
		out := make([]map[string]any, 0, len(list))
		for _, c := range list {
			if m, ok := c.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	}
	if m, ok := raw.(map[string]any); ok {
		out := make([]map[string]any, 0, len(m))
		for ip, name := range m {
			if nameStr, ok := name.(string); ok {
				out = append(out, map[string]any{"ip": ip, "name": nameStr, "group_id": ""})
			}
		}
		return out
	}
	return []map[string]any{}
}

func handleClientsDelete(w http.ResponseWriter, r *http.Request, resolver *dnsresolver.Resolver, configPath string) {
	suffix := strings.TrimPrefix(r.URL.Path, "/clients/")
	suffix = strings.TrimPrefix(suffix, "/")
	ip, err := url.PathUnescape(suffix)
	if err != nil {
		ip = suffix
	}
	ip = strings.TrimSpace(ip)
	if ip == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "client IP required (e.g. /clients/192.168.1.10)"})
		return
	}
	override, err := config.ReadOverrideMap(configPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	ci, _ := override["client_identification"].(map[string]any)
	if ci == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	clients := normalizeClientsToList(ci["clients"])
	filtered := make([]map[string]any, 0, len(clients))
	for _, c := range clients {
		if getClientIP(c) != ip {
			filtered = append(filtered, c)
		}
	}
	clients = filtered
	ci["clients"] = clients
	if err := config.WriteOverrideMap(configPath, override); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	reloadClientIdentification(w, resolver, configPath)
}

func reloadClientIdentification(w http.ResponseWriter, resolver *dnsresolver.Resolver, configPath string) {
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
