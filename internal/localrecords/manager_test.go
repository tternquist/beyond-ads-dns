package localrecords

import (
	"context"
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
