package blocklist

import (
	"bufio"
	"io"
	"net"
	"net/url"
	"strings"
)

// maxDomainLineLen: domains are max 253 chars; blocklist lines rarely exceed 1KB
const maxDomainLineLen = 1024

// initialMapCap: typical blocklists (e.g. hagezi pro) have ~1-2M domains; pre-size to reduce reallocations
const initialMapCap = 500_000

func ParseDomains(reader io.Reader) (map[string]struct{}, error) {
	result := make(map[string]struct{}, initialMapCap)
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 4096), maxDomainLineLen)
	for scanner.Scan() {
		domain, ok := normalizeDomain(scanner.Text())
		if !ok {
			continue
		}
		result[domain] = struct{}{}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

// normalizeDomain parses blocklist lines and extracts a domain for blocking.
// Supports: hosts format (0.0.0.0 domain), AdBlock-style (||domain^, |domain^),
// and extended AdBlock rules (||domain^$important, |https://domain^, etc.).
func normalizeDomain(line string) (string, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return "", false
	}
	if strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "!") {
		return "", false
	}
	if strings.HasPrefix(trimmed, "@@") {
		return "", false
	}
	if idx := strings.Index(trimmed, "#"); idx >= 0 {
		trimmed = strings.TrimSpace(trimmed[:idx])
	}
	// Strip AdBlock options: $important, $script, $domain=..., etc.
	if idx := strings.Index(trimmed, "$"); idx >= 0 {
		trimmed = strings.TrimSpace(trimmed[:idx])
	}
	trimmed = strings.TrimPrefix(trimmed, "||")
	trimmed = strings.TrimPrefix(trimmed, "|")
	trimmed = strings.TrimSuffix(trimmed, "^|")
	trimmed = strings.TrimSuffix(trimmed, "|")
	trimmed = strings.TrimSuffix(trimmed, "^")

	fields := strings.Fields(trimmed)
	if len(fields) == 0 {
		return "", false
	}

	if len(fields) >= 2 && net.ParseIP(fields[0]) != nil {
		trimmed = fields[1]
	} else {
		trimmed = fields[0]
	}

	trimmed = strings.TrimSpace(trimmed)
	// Extract domain from URL-like patterns: https://domain, http://domain
	if strings.HasPrefix(trimmed, "https://") || strings.HasPrefix(trimmed, "http://") {
		u, err := url.Parse(trimmed)
		if err == nil && u.Host != "" {
			trimmed = u.Host
		}
	}
	trimmed = strings.TrimPrefix(trimmed, "*.")
	trimmed = strings.TrimSuffix(trimmed, ".")
	trimmed = strings.ToLower(trimmed)
	if trimmed == "" {
		return "", false
	}
	if strings.ContainsAny(trimmed, " /") {
		return "", false
	}
	if strings.Contains(trimmed, "..") {
		return "", false
	}
	return trimmed, true
}
