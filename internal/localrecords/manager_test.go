package localrecords

import (
	"context"
	"strings"
	"testing"

	"github.com/miekg/dns"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/logging"
)

func TestManagerLookup(t *testing.T) {
	entries := []config.LocalRecordEntry{
		{Name: "local.example.com", Type: "A", Value: "192.168.1.1"},
		{Name: "local.example.com", Type: "AAAA", Value: "2001:db8::1"},
		{Name: "cname.example.com", Type: "CNAME", Value: "target.example.com"},
		{Name: "txt.example.com", Type: "TXT", Value: "v=spf1 include:_spf.example.com"},
	}
	m := New(entries, logging.NewDiscardLogger())

	tests := []struct {
		name     string
		qtype    uint16
		wantRR   bool
		wantRcode int
	}{
		{"local.example.com.", dns.TypeA, true, dns.RcodeSuccess},
		{"local.example.com.", dns.TypeAAAA, true, dns.RcodeSuccess},
		{"cname.example.com.", dns.TypeCNAME, true, dns.RcodeSuccess},
		{"txt.example.com.", dns.TypeTXT, true, dns.RcodeSuccess},
		{"nonexistent.example.com.", dns.TypeA, false, 0},
		{"local.example.com.", dns.TypeMX, false, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name+"_"+dns.TypeToString[tt.qtype], func(t *testing.T) {
			q := dns.Question{Name: tt.name, Qtype: tt.qtype, Qclass: dns.ClassINET}
			resp := m.Lookup(q)
			if tt.wantRR {
				if resp == nil {
					t.Fatal("expected response, got nil")
				}
				if resp.Rcode != tt.wantRcode {
					t.Errorf("Rcode = %d, want %d", resp.Rcode, tt.wantRcode)
				}
				if len(resp.Answer) == 0 {
					t.Error("expected at least one answer RR")
				}
				// Verify answer matches question
				for _, rr := range resp.Answer {
					if rr.Header().Rrtype != tt.qtype && tt.qtype != dns.TypeANY {
						t.Errorf("answer RR type %s, want %s", dns.TypeToString[rr.Header().Rrtype], dns.TypeToString[tt.qtype])
					}
				}
			} else {
				if resp != nil {
					t.Errorf("expected nil for nonexistent, got %v", resp)
				}
			}
		})
	}
}

func TestManagerLookupANY(t *testing.T) {
	entries := []config.LocalRecordEntry{
		{Name: "dual.example.com", Type: "A", Value: "10.0.0.1"},
		{Name: "dual.example.com", Type: "AAAA", Value: "2001:db8::2"},
	}
	m := New(entries, logging.NewDiscardLogger())

	q := dns.Question{Name: "dual.example.com.", Qtype: dns.TypeANY, Qclass: dns.ClassINET}
	resp := m.Lookup(q)
	if resp == nil {
		t.Fatal("expected response for ANY query, got nil")
	}
	if len(resp.Answer) != 2 {
		t.Errorf("expected 2 answers (A+AAAA), got %d", len(resp.Answer))
	}
}

func TestManagerLookupCaseInsensitive(t *testing.T) {
	entries := []config.LocalRecordEntry{
		{Name: "MixedCase.example.com", Type: "A", Value: "192.168.1.1"},
	}
	m := New(entries, logging.NewDiscardLogger())

	// Query with different case should still match
	q := dns.Question{Name: "mixedcase.example.com.", Qtype: dns.TypeA, Qclass: dns.ClassINET}
	resp := m.Lookup(q)
	if resp == nil {
		t.Fatal("expected response for case-insensitive lookup, got nil")
	}
}

func TestManagerApplyConfig(t *testing.T) {
	entries := []config.LocalRecordEntry{
		{Name: "old.example.com", Type: "A", Value: "10.0.0.1"},
	}
	m := New(entries, logging.NewDiscardLogger())

	// Verify initial record exists
	q := dns.Question{Name: "old.example.com.", Qtype: dns.TypeA, Qclass: dns.ClassINET}
	if resp := m.Lookup(q); resp == nil {
		t.Fatal("expected initial record")
	}

	// Apply new config - replace with different record
	newEntries := []config.LocalRecordEntry{
		{Name: "new.example.com", Type: "A", Value: "10.0.0.2"},
	}
	if err := m.ApplyConfig(context.Background(), newEntries); err != nil {
		t.Fatalf("ApplyConfig: %v", err)
	}

	// Old record should be gone
	if resp := m.Lookup(q); resp != nil {
		t.Error("old record should be removed after ApplyConfig")
	}

	// New record should exist
	q2 := dns.Question{Name: "new.example.com.", Qtype: dns.TypeA, Qclass: dns.ClassINET}
	if resp := m.Lookup(q2); resp == nil {
		t.Error("new record should exist after ApplyConfig")
	}
}

func TestManagerInvalidRecordsSkipped(t *testing.T) {
	entries := []config.LocalRecordEntry{
		{Name: "valid.example.com", Type: "A", Value: "192.168.1.1"},
		{Name: "invalid.example.com", Type: "A", Value: "not-an-ip"},
		{Name: "", Type: "A", Value: "10.0.0.1"},
		{Name: "emptyval.example.com", Type: "A", Value: ""},
		{Name: "unsupported.example.com", Type: "MX", Value: "10 mail.example.com"},
	}
	m := New(entries, logging.NewDiscardLogger())

	// Only valid record should work
	q := dns.Question{Name: "valid.example.com.", Qtype: dns.TypeA, Qclass: dns.ClassINET}
	if resp := m.Lookup(q); resp == nil {
		t.Error("valid record should be present")
	}

	qInvalid := dns.Question{Name: "invalid.example.com.", Qtype: dns.TypeA, Qclass: dns.ClassINET}
	if resp := m.Lookup(qInvalid); resp != nil {
		t.Error("invalid record should be skipped")
	}
}

func TestManagerPTRRecord(t *testing.T) {
	entries := []config.LocalRecordEntry{
		{Name: "1.168.192.in-addr.arpa", Type: "PTR", Value: "host.example.com"},
	}
	m := New(entries, logging.NewDiscardLogger())

	q := dns.Question{Name: "1.168.192.in-addr.arpa.", Qtype: dns.TypePTR, Qclass: dns.ClassINET}
	resp := m.Lookup(q)
	if resp == nil {
		t.Fatal("expected PTR response, got nil")
	}
	if len(resp.Answer) != 1 {
		t.Fatalf("expected 1 PTR answer, got %d", len(resp.Answer))
	}
	ptr, ok := resp.Answer[0].(*dns.PTR)
	if !ok {
		t.Fatalf("expected PTR RR, got %T", resp.Answer[0])
	}
	if ptr.Ptr != "host.example.com." {
		t.Errorf("PTR target = %q, want host.example.com.", ptr.Ptr)
	}
}

func TestManagerEmptyEntries(t *testing.T) {
	m := New(nil, nil)
	q := dns.Question{Name: "example.com.", Qtype: dns.TypeA, Qclass: dns.ClassINET}
	if resp := m.Lookup(q); resp != nil {
		t.Error("empty manager should return nil for any lookup")
	}
}

func TestManagerWildcardA(t *testing.T) {
	entries := []config.LocalRecordEntry{
		{Name: "*.local.example.com", Type: "A", Value: "192.168.1.1"},
	}
	m := New(entries, logging.NewDiscardLogger())

	tests := []struct {
		qname string
		want  bool
	}{
		{"foo.local.example.com.", true},
		{"bar.local.example.com.", true},
		{"a.b.local.example.com.", true},
		{"local.example.com.", false},
		{"other.example.com.", false},
	}
	for _, tt := range tests {
		t.Run(tt.qname, func(t *testing.T) {
			q := dns.Question{Name: tt.qname, Qtype: dns.TypeA, Qclass: dns.ClassINET}
			resp := m.Lookup(q)
			if tt.want {
				if resp == nil {
					t.Fatal("expected response, got nil")
				}
				if len(resp.Answer) == 0 {
					t.Error("expected at least one answer")
				}
				// Response must contain queried name, not wildcard
				for _, rr := range resp.Answer {
					if rr.Header().Name != dns.Fqdn(strings.TrimSuffix(tt.qname, ".")) {
						t.Errorf("answer Name = %q, want %q (RFC: wildcard expands to QNAME)", rr.Header().Name, dns.Fqdn(strings.TrimSuffix(tt.qname, ".")))
					}
				}
			} else {
				if resp != nil {
					t.Errorf("expected nil, got response")
				}
			}
		})
	}
}

func TestManagerWildcardExactPrecedence(t *testing.T) {
	entries := []config.LocalRecordEntry{
		{Name: "*.example.com", Type: "A", Value: "10.0.0.1"},
		{Name: "specific.example.com", Type: "A", Value: "192.168.1.1"},
	}
	m := New(entries, logging.NewDiscardLogger())

	// Exact record takes precedence
	q := dns.Question{Name: "specific.example.com.", Qtype: dns.TypeA, Qclass: dns.ClassINET}
	resp := m.Lookup(q)
	if resp == nil {
		t.Fatal("expected response")
	}
	if len(resp.Answer) != 1 {
		t.Fatalf("expected 1 answer, got %d", len(resp.Answer))
	}
	if a, ok := resp.Answer[0].(*dns.A); !ok || a.A.String() != "192.168.1.1" {
		t.Errorf("expected 192.168.1.1 from exact record, got %v", resp.Answer[0])
	}

	// Wildcard matches other subdomains
	q2 := dns.Question{Name: "other.example.com.", Qtype: dns.TypeA, Qclass: dns.ClassINET}
	resp2 := m.Lookup(q2)
	if resp2 == nil {
		t.Fatal("expected wildcard response")
	}
	if a, ok := resp2.Answer[0].(*dns.A); !ok || a.A.String() != "10.0.0.1" {
		t.Errorf("expected 10.0.0.1 from wildcard, got %v", resp2.Answer[0])
	}
}

func TestManagerWildcardCNAME(t *testing.T) {
	entries := []config.LocalRecordEntry{
		{Name: "*.alias.example.com", Type: "CNAME", Value: "target.example.com"},
		{Name: "target.example.com", Type: "A", Value: "192.168.1.1"},
	}
	m := New(entries, logging.NewDiscardLogger())

	cname, ok := m.LookupCNAME("foo.alias.example.com")
	if !ok || cname == nil {
		t.Fatal("expected CNAME for foo.alias.example.com")
	}
	if cname.Target != "target.example.com." {
		t.Errorf("CNAME target = %q, want target.example.com.", cname.Target)
	}
	if cname.Hdr.Name != "foo.alias.example.com." {
		t.Errorf("CNAME name (wildcard expansion) = %q, want foo.alias.example.com.", cname.Hdr.Name)
	}
}

func TestManagerWildcardAVsExactCNAMEPrecedence(t *testing.T) {
	// Per RFC 1034: exact records (including CNAME) take precedence over wildcards.
	// When foo.example.com has an exact CNAME, wildcard *.example.com A must NOT be used.
	entries := []config.LocalRecordEntry{
		{Name: "*.example.com", Type: "A", Value: "10.0.0.99"},
		{Name: "foo.example.com", Type: "CNAME", Value: "target.example.com"},
		{Name: "target.example.com", Type: "A", Value: "192.168.1.100"},
	}
	m := New(entries, logging.NewDiscardLogger())

	// A query for foo.example.com: exact CNAME exists, so wildcard A must NOT apply.
	// Lookup returns nil so resolver can follow CNAME chain (CNAME + target A).
	q := dns.Question{Name: "foo.example.com.", Qtype: dns.TypeA, Qclass: dns.ClassINET}
	resp := m.Lookup(q)
	if resp != nil {
		t.Errorf("Lookup must return nil when exact CNAME exists (wildcard A must not apply); got response with %d answers", len(resp.Answer))
	}

	// Subdomain without exact record: wildcard A should still apply
	q2 := dns.Question{Name: "bar.example.com.", Qtype: dns.TypeA, Qclass: dns.ClassINET}
	resp2 := m.Lookup(q2)
	if resp2 == nil {
		t.Fatal("expected wildcard A response for bar.example.com (no exact record)")
	}
	if len(resp2.Answer) != 1 {
		t.Fatalf("expected 1 answer, got %d", len(resp2.Answer))
	}
	if a, ok := resp2.Answer[0].(*dns.A); !ok || a.A.String() != "10.0.0.99" {
		t.Errorf("expected wildcard A 10.0.0.99, got %v", resp2.Answer[0])
	}
}

func TestManagerLookupCNAME(t *testing.T) {
	entries := []config.LocalRecordEntry{
		{Name: "cname.example.com", Type: "CNAME", Value: "target.example.com"},
		{Name: "a.example.com", Type: "A", Value: "192.168.1.1"},
	}
	m := New(entries, logging.NewDiscardLogger())

	cname, ok := m.LookupCNAME("cname.example.com")
	if !ok || cname == nil {
		t.Fatal("expected CNAME for cname.example.com")
	}
	if cname.Target != "target.example.com." {
		t.Errorf("CNAME target = %q, want target.example.com.", cname.Target)
	}

	// With trailing dot
	cname2, ok2 := m.LookupCNAME("cname.example.com.")
	if !ok2 || cname2 == nil {
		t.Fatal("expected CNAME for cname.example.com. (with dot)")
	}

	// No CNAME for A-only name
	_, ok = m.LookupCNAME("a.example.com")
	if ok {
		t.Error("expected no CNAME for a.example.com")
	}

	// Nonexistent
	_, ok = m.LookupCNAME("nonexistent.example.com")
	if ok {
		t.Error("expected no CNAME for nonexistent name")
	}

	// Empty manager
	mEmpty := New(nil, nil)
	_, ok = mEmpty.LookupCNAME("any.example.com")
	if ok {
		t.Error("empty manager should return false for LookupCNAME")
	}
}
