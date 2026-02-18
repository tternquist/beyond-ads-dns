package clientid

import (
	"net"
	"strings"
	"sync"
)

// Resolver maps client IPs to friendly names and group IDs for per-device analytics and per-group policies.
type Resolver struct {
	mu      sync.RWMutex
	clients map[string]string // IP -> name
	groups  map[string]string // IP -> group_id
}

// New creates a Resolver with the given IP->name and optional IP->group mappings.
func New(clients map[string]string, groups map[string]string) *Resolver {
	r := &Resolver{
		clients: make(map[string]string),
		groups:  make(map[string]string),
	}
	if clients != nil {
		for ip, name := range clients {
			ip = strings.TrimSpace(ip)
			name = strings.TrimSpace(name)
			if ip != "" && name != "" {
				r.clients[ip] = name
			}
		}
	}
	if groups != nil {
		for ip, groupID := range groups {
			ip = strings.TrimSpace(ip)
			groupID = strings.TrimSpace(groupID)
			if ip != "" && groupID != "" {
				r.groups[ip] = groupID
			}
		}
	}
	return r
}

// Resolve returns the client name for the given IP, or the IP itself if no mapping exists.
func (r *Resolver) Resolve(ip string) string {
	ip = normalizeIP(ip)
	if ip == "" {
		return ""
	}
	r.mu.RLock()
	name, ok := r.clients[ip]
	r.mu.RUnlock()
	if ok {
		return name
	}
	return ip
}

// ResolveGroup returns the group ID for the given IP, or "" if no group is assigned.
func (r *Resolver) ResolveGroup(ip string) string {
	ip = normalizeIP(ip)
	if ip == "" {
		return ""
	}
	r.mu.RLock()
	groupID := r.groups[ip]
	r.mu.RUnlock()
	return groupID
}

func normalizeIP(ip string) string {
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(ip); err == nil {
		return host
	}
	return ip
}

// ApplyConfig updates the resolver with new IP->name and IP->group mappings.
func (r *Resolver) ApplyConfig(clients map[string]string, groups map[string]string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clients = make(map[string]string)
	r.groups = make(map[string]string)
	if clients != nil {
		for ip, name := range clients {
			ip = strings.TrimSpace(ip)
			name = strings.TrimSpace(name)
			if ip != "" && name != "" {
				r.clients[ip] = name
			}
		}
	}
	if groups != nil {
		for ip, groupID := range groups {
			ip = strings.TrimSpace(ip)
			groupID = strings.TrimSpace(groupID)
			if ip != "" && groupID != "" {
				r.groups[ip] = groupID
			}
		}
	}
}
