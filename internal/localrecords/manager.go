package localrecords

import (
	"context"
	"log/slog"
	"net"
	"strings"
	"sync"

	"github.com/miekg/dns"
	"github.com/tternquist/beyond-ads-dns/internal/config"
)

const defaultTTL = 3600 // 1 hour for local records

// Manager holds local DNS records and provides thread-safe lookup.
// These records are returned without upstream lookup, so they work when internet is down.
type Manager struct {
	mu      sync.RWMutex
	records map[string]map[uint16][]dns.RR // key: normalized name, inner key: qtype
	logger  *slog.Logger
}

// New creates a manager with the given records.
func New(entries []config.LocalRecordEntry, logger *slog.Logger) *Manager {
	m := &Manager{
		records: make(map[string]map[uint16][]dns.RR),
		logger:  logger,
	}
	if len(entries) > 0 {
		m.applyEntries(entries)
	}
	return m
}

// Lookup returns a DNS response if the question matches a local record, nil otherwise.
func (m *Manager) Lookup(question dns.Question) *dns.Msg {
	qname := normalizeName(question.Name)
	if qname == "" {
		return nil
	}
	qtype := question.Qtype

	m.mu.RLock()
	defer m.mu.RUnlock()

	// Try exact match first
	if rrs := m.records[qname][qtype]; len(rrs) > 0 {
		return m.buildResponse(question, rrs)
	}
	// Try ANY for A/AAAA
	if qtype == dns.TypeANY {
		var all []dns.RR
		for _, rr := range m.records[qname][dns.TypeA] {
			all = append(all, rr)
		}
		for _, rr := range m.records[qname][dns.TypeAAAA] {
			all = append(all, rr)
		}
		if len(all) > 0 {
			return m.buildResponse(question, all)
		}
	}
	return nil
}

// LookupCNAME returns a CNAME RR if the name has a local CNAME record, otherwise (nil, false).
// name is normalized (TrimSpace, TrimSuffix ".", ToLower) before lookup.
func (m *Manager) LookupCNAME(name string) (*dns.CNAME, bool) {
	qname := normalizeName(name)
	if qname == "" {
		return nil, false
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	rrs := m.records[qname][dns.TypeCNAME]
	if len(rrs) == 0 {
		return nil, false
	}
	if cname, ok := rrs[0].(*dns.CNAME); ok {
		return cname, true
	}
	return nil, false
}

// ApplyConfig updates the records from config. Thread-safe.
func (m *Manager) ApplyConfig(ctx context.Context, entries []config.LocalRecordEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.records = make(map[string]map[uint16][]dns.RR)
	if len(entries) > 0 {
		m.applyEntries(entries)
	}
	return nil
}

func (m *Manager) applyEntries(entries []config.LocalRecordEntry) {
	for _, e := range entries {
		name := normalizeName(e.Name)
		if name == "" || e.Type == "" || e.Value == "" {
			continue
		}
		rr, err := recordToRR(name, e.Type, e.Value)
		if err != nil {
			if m.logger != nil {
				m.logger.Error("local record parse error", "name", e.Name, "type", e.Type, "value", e.Value, "err", err)
			}
			continue
		}
		if m.records[name] == nil {
			m.records[name] = make(map[uint16][]dns.RR)
		}
		qtype := rr.Header().Rrtype
		m.records[name][qtype] = append(m.records[name][qtype], rr)
	}
}

func (m *Manager) buildResponse(question dns.Question, answers []dns.RR) *dns.Msg {
	resp := new(dns.Msg)
	resp.SetReply(&dns.Msg{Question: []dns.Question{question}})
	resp.Authoritative = true
	resp.Answer = answers
	return resp
}

func recordToRR(name, typ, value string) (dns.RR, error) {
	fqdn := dns.Fqdn(name)
	switch typ {
	case "A":
		ip := net.ParseIP(value)
		if ip == nil || ip.To4() == nil {
			return nil, &invalidRecordError{msg: "invalid A record IP: " + value}
		}
		return &dns.A{
			Hdr: dns.RR_Header{Name: fqdn, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: defaultTTL},
			A:   ip.To4(),
		}, nil
	case "AAAA":
		ip := net.ParseIP(value)
		if ip == nil || ip.To4() != nil {
			return nil, &invalidRecordError{msg: "invalid AAAA record IP: " + value}
		}
		return &dns.AAAA{
			Hdr:  dns.RR_Header{Name: fqdn, Rrtype: dns.TypeAAAA, Class: dns.ClassINET, Ttl: defaultTTL},
			AAAA: ip,
		}, nil
	case "CNAME":
		target := dns.Fqdn(value)
		return &dns.CNAME{
			Hdr:    dns.RR_Header{Name: fqdn, Rrtype: dns.TypeCNAME, Class: dns.ClassINET, Ttl: defaultTTL},
			Target: target,
		}, nil
	case "TXT":
		return &dns.TXT{
			Hdr: dns.RR_Header{Name: fqdn, Rrtype: dns.TypeTXT, Class: dns.ClassINET, Ttl: defaultTTL},
			Txt: []string{value},
		}, nil
	case "PTR":
		target := dns.Fqdn(value)
		return &dns.PTR{
			Hdr: dns.RR_Header{Name: fqdn, Rrtype: dns.TypePTR, Class: dns.ClassINET, Ttl: defaultTTL},
			Ptr: target,
		}, nil
	default:
		return nil, &invalidRecordError{msg: "unsupported type: " + typ}
	}
}

type invalidRecordError struct{ msg string }

func (e *invalidRecordError) Error() string { return e.msg }

func normalizeName(name string) string {
	s := strings.TrimSpace(strings.TrimSuffix(name, "."))
	return strings.ToLower(s)
}
