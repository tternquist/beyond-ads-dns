package anonymize

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"strings"
)

// IP anonymizes an IP address string based on mode.
// Mode: "none" (return as-is), "hash" (SHA256 hex prefix), "truncate" (IPv4 /24, IPv6 /64).
func IP(ip string, mode string) string {
	ip = strings.TrimSpace(ip)
	if ip == "" || mode == "" || mode == "none" {
		return ip
	}
	switch mode {
	case "hash":
		return hashIP(ip)
	case "truncate":
		return truncateIP(ip)
	default:
		return ip
	}
}

func hashIP(ip string) string {
	h := sha256.Sum256([]byte(ip))
	// Use first 16 hex chars (64 bits) - enough for analytics, not reversible
	return hex.EncodeToString(h[:8])
}

func truncateIP(ip string) string {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return ip
	}
	if v4 := parsed.To4(); v4 != nil {
		// IPv4: zero last octet -> /24 (copy to avoid mutating shared buffer)
		out := make(net.IP, 4)
		copy(out, v4)
		out[3] = 0
		return out.String()
	}
	// IPv6: zero last 64 bits -> /64
	if len(parsed) >= 16 {
		out := make(net.IP, 16)
		copy(out, parsed)
		for i := 8; i < 16; i++ {
			out[i] = 0
		}
		return out.String()
	}
	return ip
}
