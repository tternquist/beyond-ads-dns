package blocklist

import (
	"bufio"
	"io"
	"net"
	"strings"
)

const maxScanTokenSize = 1024 * 1024

func ParseDomains(reader io.Reader) (map[string]struct{}, error) {
	result := make(map[string]struct{})
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), maxScanTokenSize)
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
	trimmed = strings.TrimPrefix(trimmed, "||")
	trimmed = strings.TrimPrefix(trimmed, "|")
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
