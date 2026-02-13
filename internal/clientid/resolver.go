package clientid

import (
	"net"
	"strings"
	"sync"
)

// Resolver maps client IPs to friendly names for per-device analytics.
type Resolver struct {
	mu      sync.RWMutex
	clients map[string]string // IP -> name
}

// New creates a Resolver with the given IP->name mappings.
// Keys are IP addresses (e.g. "192.168.1.10"); values are display names (e.g. "kids-phone").
func New(clients map[string]string) *Resolver {
	r := &Resolver{clients: make(map[string]string)}
	if clients != nil {
		for ip, name := range clients {
			ip = strings.TrimSpace(ip)
			name = strings.TrimSpace(name)
			if ip != "" && name != "" {
				r.clients[ip] = name
			}
		}
	}
	return r
}

// Resolve returns the client name for the given IP, or the IP itself if no mapping exists.
func (r *Resolver) Resolve(ip string) string {
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return ""
	}
	// Normalize: remove port if present
	if host, _, err := net.SplitHostPort(ip); err == nil {
		ip = host
	}
	r.mu.RLock()
	name, ok := r.clients[ip]
	r.mu.RUnlock()
	if ok {
		return name
	}
	return ip
}

// ApplyConfig updates the resolver with new IP->name mappings.
func (r *Resolver) ApplyConfig(clients map[string]string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clients = make(map[string]string)
	if clients != nil {
		for ip, name := range clients {
			ip = strings.TrimSpace(ip)
			name = strings.TrimSpace(name)
			if ip != "" && name != "" {
				r.clients[ip] = name
			}
		}
	}
}
