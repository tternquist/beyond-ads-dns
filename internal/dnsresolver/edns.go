package dnsresolver

import (
	"github.com/miekg/dns"
)

// ednsUDPSize is the EDNS0 UDP payload size this resolver advertises in
// responses and on upstream queries. 1232 bytes avoids IP fragmentation on
// virtually all networks (DNS Flag Day 2020 recommendation).
const ednsUDPSize = 1232

// clientEdns captures the EDNS0 state of an inbound request. It must be
// captured before the request is forwarded upstream, because exchange adds an
// OPT record to requests that lack one.
type clientEdns struct {
	hasEdns bool
	do      bool
	udpSize uint16 // client's advertised UDP payload size (>= 512)
	udp     bool   // transport is plain UDP (responses must fit udpSize)
}

func clientEdnsFromRequest(w dns.ResponseWriter, req *dns.Msg) clientEdns {
	info := clientEdns{udpSize: dns.MinMsgSize}
	if w != nil {
		if addr := w.RemoteAddr(); addr != nil {
			info.udp = addr.Network() == "udp"
		}
	}
	if req == nil {
		return info
	}
	if opt := req.IsEdns0(); opt != nil {
		info.hasEdns = true
		info.do = opt.Do()
		if size := opt.UDPSize(); size > dns.MinMsgSize {
			info.udpSize = size
		}
	}
	return info
}

// ensureEdns0 adds an OPT record advertising size when msg has none, so
// upstream responses larger than 512 bytes arrive over UDP instead of
// forcing a TCP retry.
func ensureEdns0(msg *dns.Msg, size uint16) {
	if msg == nil || msg.IsEdns0() != nil {
		return
	}
	msg.SetEdns0(size, false)
}

// stripOpt removes OPT records from msg.Extra. OPT is hop-by-hop (RFC 6891)
// and must not be cached or sent to clients that didn't use EDNS0.
func stripOpt(msg *dns.Msg) {
	if msg == nil || len(msg.Extra) == 0 {
		return
	}
	keep := true
	for _, rr := range msg.Extra {
		if rr.Header().Rrtype == dns.TypeOPT {
			keep = false
			break
		}
	}
	if keep {
		return
	}
	extra := make([]dns.RR, 0, len(msg.Extra)-1)
	for _, rr := range msg.Extra {
		if rr.Header().Rrtype != dns.TypeOPT {
			extra = append(extra, rr)
		}
	}
	msg.Extra = extra
}

// prepareResponse normalizes resp for the client per RFC 6891: any upstream
// OPT record is removed, a fresh OPT (mirroring the client's DO bit) is added
// for EDNS0 clients, and UDP responses are truncated to the client's
// advertised buffer size. resp.Extra may be modified in place; when
// truncation is required a truncated copy is returned so callers can still
// cache the full response.
func prepareResponse(ce clientEdns, resp *dns.Msg) *dns.Msg {
	if resp == nil {
		return nil
	}
	stripOpt(resp)
	if ce.hasEdns {
		opt := &dns.OPT{Hdr: dns.RR_Header{Name: ".", Rrtype: dns.TypeOPT}}
		opt.SetUDPSize(ednsUDPSize)
		if ce.do {
			opt.SetDo()
		}
		resp.Extra = append(resp.Extra, opt)
	}
	if !ce.udp {
		return resp
	}
	limit := dns.MinMsgSize
	if ce.hasEdns {
		limit = int(ce.udpSize)
		if limit > ednsUDPSize {
			limit = ednsUDPSize
		}
	}
	if resp.Len() <= limit {
		return resp
	}
	out := resp.Copy()
	out.Truncate(limit)
	return out
}
