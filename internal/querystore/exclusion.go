package querystore

import (
	"regexp"
	"strings"
	"sync"
)

// ExclusionFilter determines whether a query event should be excluded from statistics.
type ExclusionFilter struct {
	mu sync.RWMutex

	// domainExact: normalized domain -> struct{} for exact/suffix match
	domainExact map[string]struct{}
	// domainRegex: compiled regex patterns
	domainRegex []*regexp.Regexp
	// clientSet: IP or client name -> struct{}
	clientSet map[string]struct{}
}

// NewExclusionFilter builds a filter from exclude_domains and exclude_clients config.
// Returns nil when both lists are empty (no exclusions).
func NewExclusionFilter(excludeDomains, excludeClients []string) *ExclusionFilter {
	if len(excludeDomains) == 0 && len(excludeClients) == 0 {
		return nil
	}
	f := &ExclusionFilter{
		domainExact: make(map[string]struct{}),
		domainRegex:  make([]*regexp.Regexp, 0),
		clientSet:    make(map[string]struct{}),
	}
	for _, d := range excludeDomains {
		trimmed := strings.TrimSpace(d)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "/") && strings.HasSuffix(trimmed, "/") && len(trimmed) > 2 {
			pattern := trimmed[1 : len(trimmed)-1]
			if re, err := regexp.Compile(pattern); err == nil {
				f.domainRegex = append(f.domainRegex, re)
			}
		} else {
			normalized := strings.ToLower(strings.TrimSuffix(trimmed, "."))
			if normalized != "" {
				f.domainExact[normalized] = struct{}{}
			}
		}
	}
	for _, c := range excludeClients {
		trimmed := strings.TrimSpace(c)
		if trimmed != "" {
			f.clientSet[trimmed] = struct{}{}
			f.clientSet[strings.ToLower(trimmed)] = struct{}{} // case-insensitive for names
		}
	}
	return f
}

// Excluded returns true if the event should be excluded from query statistics.
func (f *ExclusionFilter) Excluded(qname, clientIP, clientName string) bool {
	if f == nil {
		return false
	}
	f.mu.RLock()
	defer f.mu.RUnlock()

	if f.domainMatches(qname) {
		return true
	}
	if f.clientMatches(clientIP, clientName) {
		return true
	}
	return false
}

func (f *ExclusionFilter) domainMatches(name string) bool {
	normalized := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(name), "."))
	if normalized == "" {
		return false
	}
	// Exact/suffix match: "example.com" matches "example.com" and "a.example.com"
	if len(f.domainExact) > 0 {
		remaining := normalized
		for {
			if _, ok := f.domainExact[remaining]; ok {
				return true
			}
			idx := strings.IndexByte(remaining, '.')
			if idx == -1 {
				break
			}
			remaining = remaining[idx+1:]
		}
	}
	for _, re := range f.domainRegex {
		if re.MatchString(normalized) {
			return true
		}
	}
	return false
}

func (f *ExclusionFilter) clientMatches(clientIP, clientName string) bool {
	if len(f.clientSet) == 0 {
		return false
	}
	if clientIP != "" {
		if _, ok := f.clientSet[clientIP]; ok {
			return true
		}
	}
	if clientName != "" {
		if _, ok := f.clientSet[clientName]; ok {
			return true
		}
		if _, ok := f.clientSet[strings.ToLower(clientName)]; ok {
			return true
		}
	}
	return false
}

// Update replaces the filter's rules. Safe to call from config reload.
func (f *ExclusionFilter) Update(excludeDomains, excludeClients []string) {
	if f == nil {
		return
	}
	newFilter := NewExclusionFilter(excludeDomains, excludeClients)
	if newFilter == nil {
		f.mu.Lock()
		f.domainExact = make(map[string]struct{})
		f.domainRegex = nil
		f.clientSet = make(map[string]struct{})
		f.mu.Unlock()
		return
	}
	f.mu.Lock()
	f.domainExact = newFilter.domainExact
	f.domainRegex = newFilter.domainRegex
	f.clientSet = newFilter.clientSet
	f.mu.Unlock()
}
