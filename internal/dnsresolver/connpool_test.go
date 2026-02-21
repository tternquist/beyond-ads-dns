package dnsresolver

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/miekg/dns"
)

func TestIsRetriableError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"EOF", io.EOF, true},
		{"wrapped EOF", errors.Join(io.EOF), true},
		{"write error", errors.New("write: broken pipe"), true},
		{"connection reset", errors.New("read tcp: connection reset by peer"), true},
		{"connection refused", errors.New("dial tcp: connection refused"), true},
		{"closed network", errors.New("use of closed network connection"), true},
		{"timeout", errors.New("i/o timeout"), false},
		{"generic", errors.New("something else"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isRetriableError(tt.err)
			if got != tt.want {
				t.Errorf("isRetriableError(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

// startTCPDNSServer starts a TCP DNS server that responds to queries.
// If closeAfterResponse is true, the server closes the connection after each response (simulates EOF on reuse).
func startTCPDNSServer(t *testing.T, closeAfterResponse bool) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	addr := listener.Addr().String()
	handler := dns.HandlerFunc(func(w dns.ResponseWriter, r *dns.Msg) {
		resp := new(dns.Msg)
		resp.SetReply(r)
		resp.Authoritative = true
		resp.Answer = []dns.RR{
			&dns.A{
				Hdr: dns.RR_Header{Name: r.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.IPv4(192, 168, 1, 1),
			},
		}
		_ = w.WriteMsg(resp)
		if closeAfterResponse {
			w.Close()
		}
	})
	srv := &dns.Server{Listener: listener, Handler: handler}
	go func() {
		_ = srv.ActivateAndServe()
	}()
	t.Cleanup(func() { _ = srv.Shutdown() })
	return addr
}

// TestConnPoolConcurrentAccess verifies the pool handles concurrent exchanges correctly.
func TestConnPoolConcurrentAccess(t *testing.T) {
	addr := startTCPDNSServer(t, false)
	client := &dns.Client{Net: "tcp", Timeout: 5 * time.Second}
	pool := newConnPool(client, addr, 0, false)
	defer drainConnPool(pool)

	req := new(dns.Msg)
	req.SetQuestion("example.com.", dns.TypeA)

	const concurrency = 20
	var wg sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			resp, _, err := pool.exchange(ctx, req)
			if err != nil {
				t.Errorf("exchange: %v", err)
				return
			}
			if resp == nil || len(resp.Answer) == 0 {
				t.Error("expected answer")
			}
		}()
	}
	wg.Wait()
}

// TestConnPoolIdleTimeoutEviction verifies connections exceeding idle timeout are not reused.
func TestConnPoolIdleTimeoutEviction(t *testing.T) {
	addr := startTCPDNSServer(t, false)
	client := &dns.Client{Net: "tcp", Timeout: 5 * time.Second}
	idleTimeout := 50 * time.Millisecond
	pool := newConnPool(client, addr, idleTimeout, false)
	defer drainConnPool(pool)

	req := new(dns.Msg)
	req.SetQuestion("example.com.", dns.TypeA)
	ctx := context.Background()

	// First exchange - gets fresh conn, puts back
	resp1, _, err := pool.exchange(ctx, req)
	if err != nil {
		t.Fatalf("first exchange: %v", err)
	}
	if resp1 == nil {
		t.Fatal("expected response")
	}

	// Wait for idle timeout to expire
	time.Sleep(idleTimeout + 30*time.Millisecond)

	// Second exchange - pooled conn should have been evicted (closed), so we get fresh
	resp2, _, err := pool.exchange(ctx, req)
	if err != nil {
		t.Fatalf("second exchange: %v", err)
	}
	if resp2 == nil {
		t.Fatal("expected response")
	}
}

// TestConnPoolRetryOnEOF verifies that when a pooled connection returns EOF, the pool retries with a fresh connection.
func TestConnPoolRetryOnEOF(t *testing.T) {
	// Server closes connection after each response - next use of pooled conn will get EOF
	addr := startTCPDNSServer(t, true)
	client := &dns.Client{Net: "tcp", Timeout: 5 * time.Second}
	pool := newConnPool(client, addr, 0, false)
	defer drainConnPool(pool)

	req := new(dns.Msg)
	req.SetQuestion("example.com.", dns.TypeA)
	ctx := context.Background()

	// First exchange - gets fresh conn, server responds and closes, we put "conn" back (actually dead)
	resp1, _, err := pool.exchange(ctx, req)
	if err != nil {
		t.Fatalf("first exchange: %v", err)
	}
	if resp1 == nil || len(resp1.Answer) == 0 {
		t.Fatal("expected answer from first exchange")
	}

	// Second exchange - getConn returns the pooled conn (server closed it), exchange gets EOF,
	// isRetriableError(EOF)=true, retries with fresh dial, succeeds
	resp2, _, err := pool.exchange(ctx, req)
	if err != nil {
		t.Fatalf("second exchange (after EOF retry): %v", err)
	}
	if resp2 == nil || len(resp2.Answer) == 0 {
		t.Fatal("expected answer from second exchange after EOF retry")
	}
}
