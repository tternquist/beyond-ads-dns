package dnsresolver

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/miekg/dns"
	"github.com/tternquist/beyond-ads-dns/internal/blocklist"
	"github.com/tternquist/beyond-ads-dns/internal/config"
	"github.com/tternquist/beyond-ads-dns/internal/logging"
)

func newOpt(size uint16, do bool) *dns.OPT {
	opt := &dns.OPT{Hdr: dns.RR_Header{Name: ".", Rrtype: dns.TypeOPT}}
	opt.SetUDPSize(size)
	if do {
		opt.SetDo()
	}
	return opt
}

func TestClientEdnsFromRequest(t *testing.T) {
	udpWriter := &mockResponseWriter{}                       // RemoteAddr defaults to UDP
	tcpWriter := &mockResponseWriter{remoteAddr: "10.0.0.1"} // RemoteAddr is TCP

	tests := []struct {
		name string
		w    dns.ResponseWriter
		opt  *dns.OPT
		want clientEdns
	}{
		{"udp no edns", udpWriter, nil, clientEdns{udp: true, udpSize: dns.MinMsgSize}},
		{"udp edns 4096", udpWriter, newOpt(4096, false), clientEdns{udp: true, hasEdns: true, udpSize: 4096}},
		{"udp edns do", udpWriter, newOpt(1232, true), clientEdns{udp: true, hasEdns: true, do: true, udpSize: 1232}},
		{"udp edns tiny clamped", udpWriter, newOpt(100, false), clientEdns{udp: true, hasEdns: true, udpSize: dns.MinMsgSize}},
		{"tcp no edns", tcpWriter, nil, clientEdns{udpSize: dns.MinMsgSize}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := new(dns.Msg)
			req.SetQuestion("example.com.", dns.TypeA)
			if tt.opt != nil {
				req.Extra = append(req.Extra, tt.opt)
			}
			got := clientEdnsFromRequest(tt.w, req)
			if got != tt.want {
				t.Errorf("clientEdnsFromRequest = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestEnsureEdns0(t *testing.T) {
	msg := new(dns.Msg)
	msg.SetQuestion("example.com.", dns.TypeA)
	ensureEdns0(msg, ednsUDPSize)
	opt := msg.IsEdns0()
	if opt == nil {
		t.Fatal("expected OPT record after ensureEdns0")
	}
	if opt.UDPSize() != ednsUDPSize {
		t.Errorf("UDPSize = %d, want %d", opt.UDPSize(), ednsUDPSize)
	}

	// Existing OPT is preserved, not replaced.
	msg2 := new(dns.Msg)
	msg2.SetQuestion("example.com.", dns.TypeA)
	msg2.SetEdns0(4096, true)
	ensureEdns0(msg2, ednsUDPSize)
	opt2 := msg2.IsEdns0()
	if opt2 == nil || opt2.UDPSize() != 4096 || !opt2.Do() {
		t.Errorf("existing OPT was modified: %v", opt2)
	}
	count := 0
	for _, rr := range msg2.Extra {
		if rr.Header().Rrtype == dns.TypeOPT {
			count++
		}
	}
	if count != 1 {
		t.Errorf("OPT count = %d, want 1", count)
	}
}

func TestStripOpt(t *testing.T) {
	msg := new(dns.Msg)
	msg.SetQuestion("example.com.", dns.TypeA)
	extraA := &dns.A{
		Hdr: dns.RR_Header{Name: "extra.example.com.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
		A:   net.IPv4(192, 0, 2, 1),
	}
	msg.Extra = []dns.RR{extraA, newOpt(1232, false)}
	stripOpt(msg)
	if len(msg.Extra) != 1 || msg.Extra[0] != dns.RR(extraA) {
		t.Errorf("Extra = %v, want only the A record", msg.Extra)
	}
	// No-op when there is no OPT.
	stripOpt(msg)
	if len(msg.Extra) != 1 {
		t.Errorf("Extra after second strip = %v, want 1 record", msg.Extra)
	}
}

func largeResponse(qname string, answers int) *dns.Msg {
	resp := new(dns.Msg)
	resp.SetQuestion(qname, dns.TypeA)
	resp.Response = true
	for i := 0; i < answers; i++ {
		resp.Answer = append(resp.Answer, &dns.A{
			Hdr: dns.RR_Header{Name: qname, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
			A:   net.IPv4(192, 0, 2, byte(i)),
		})
	}
	return resp
}

func TestPrepareResponseStripsOptForNonEdnsClient(t *testing.T) {
	resp := largeResponse("example.com.", 2)
	resp.Extra = append(resp.Extra, newOpt(4096, false))
	out := prepareResponse(clientEdns{udp: true, udpSize: dns.MinMsgSize}, resp)
	if out.IsEdns0() != nil {
		t.Error("expected OPT removed for non-EDNS0 client")
	}
	if out.Truncated {
		t.Error("small response should not be truncated")
	}
}

func TestPrepareResponseAddsOptForEdnsClient(t *testing.T) {
	resp := largeResponse("example.com.", 2)
	out := prepareResponse(clientEdns{udp: true, hasEdns: true, do: true, udpSize: 4096}, resp)
	opt := out.IsEdns0()
	if opt == nil {
		t.Fatal("expected OPT for EDNS0 client")
	}
	if opt.UDPSize() != ednsUDPSize {
		t.Errorf("advertised UDPSize = %d, want %d", opt.UDPSize(), ednsUDPSize)
	}
	if !opt.Do() {
		t.Error("expected DO bit mirrored from request")
	}
}

func TestPrepareResponseTruncatesUDP(t *testing.T) {
	// ~50 A records ≈ 2KB uncompressed: exceeds 512 for non-EDNS clients.
	resp := largeResponse("example.com.", 50)
	original := len(resp.Answer)

	out := prepareResponse(clientEdns{udp: true, udpSize: dns.MinMsgSize}, resp)
	if !out.Truncated {
		t.Error("expected TC bit for oversized UDP response")
	}
	if out.Len() > dns.MinMsgSize {
		t.Errorf("truncated response Len = %d, want <= %d", out.Len(), dns.MinMsgSize)
	}
	// Original is left intact for caching.
	if len(resp.Answer) != original || resp.Truncated {
		t.Error("prepareResponse must not truncate the original message")
	}
}

func TestPrepareResponseNoTruncationOverTCP(t *testing.T) {
	resp := largeResponse("example.com.", 50)
	out := prepareResponse(clientEdns{udp: false, udpSize: dns.MinMsgSize}, resp)
	if out.Truncated {
		t.Error("TCP responses must not be truncated")
	}
	if len(out.Answer) != 50 {
		t.Errorf("Answer count = %d, want 50", len(out.Answer))
	}
}

func TestPrepareResponseCapsEdnsLimit(t *testing.T) {
	// Client advertises 4096 but we cap UDP responses at ednsUDPSize.
	resp := largeResponse("example.com.", 100) // ~4KB
	out := prepareResponse(clientEdns{udp: true, hasEdns: true, udpSize: 4096}, resp)
	if !out.Truncated {
		t.Error("expected truncation at ednsUDPSize cap")
	}
	if out.Len() > ednsUDPSize {
		t.Errorf("response Len = %d, want <= %d", out.Len(), ednsUDPSize)
	}
}

// TestServeDNSEdns0EndToEnd verifies that upstream queries gain an OPT record,
// EDNS0 clients get a normalized OPT back, and non-EDNS0 clients get none.
func TestServeDNSEdns0EndToEnd(t *testing.T) {
	blCfg := config.BlocklistConfig{
		RefreshInterval: config.Duration{Duration: time.Hour},
		Sources:         []config.BlocklistSource{},
	}
	blMgr := blocklist.NewManager(blCfg, logging.NewDiscardLogger())
	blMgr.LoadOnce(nil)

	var sawUpstreamOpt bool
	dohHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		req := new(dns.Msg)
		if err := req.Unpack(body); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		sawUpstreamOpt = req.IsEdns0() != nil
		resp := new(dns.Msg)
		resp.SetReply(req)
		resp.Answer = []dns.RR{&dns.A{
			Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
			A:   net.IPv4(192, 0, 2, 1),
		}}
		// Upstream includes its own OPT; it must not leak to non-EDNS0 clients.
		resp.SetEdns0(4096, false)
		packed, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(packed)
	})
	dohSrv := newHTTPServer(dohHandler)
	defer dohSrv.Close()

	cfg := minimalResolverConfig(dohSrv.URL)
	cfg.Blocklists = blCfg
	resolver := buildTestResolver(t, cfg, nil, blMgr, nil)

	// Non-EDNS0 client: upstream query gains OPT, response has none.
	req := new(dns.Msg)
	req.SetQuestion("edns-test.example.", dns.TypeA)
	w := &mockResponseWriter{}
	resolver.ServeDNS(w, req)
	if w.written == nil {
		t.Fatal("expected response")
	}
	if !sawUpstreamOpt {
		t.Error("expected upstream query to carry an EDNS0 OPT record")
	}
	if w.written.IsEdns0() != nil {
		t.Error("non-EDNS0 client must not receive an OPT record")
	}

	// EDNS0 client: response carries our OPT.
	req2 := new(dns.Msg)
	req2.SetQuestion(fmt.Sprintf("edns-test-%d.example.", time.Now().UnixNano()), dns.TypeA)
	req2.SetEdns0(4096, false)
	w2 := &mockResponseWriter{}
	resolver.ServeDNS(w2, req2)
	if w2.written == nil {
		t.Fatal("expected response")
	}
	opt := w2.written.IsEdns0()
	if opt == nil {
		t.Fatal("EDNS0 client should receive an OPT record")
	}
	if opt.UDPSize() != ednsUDPSize {
		t.Errorf("response OPT UDPSize = %d, want %d", opt.UDPSize(), ednsUDPSize)
	}
}
