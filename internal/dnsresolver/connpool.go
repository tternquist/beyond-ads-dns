package dnsresolver

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/miekg/dns"
)

const (
	connPoolSize = 10 // max idle conns per upstream address
)

// pooledConn wraps a connection with its idle timestamp for reuse decisions.
type pooledConn struct {
	conn     *dns.Conn
	idleSince time.Time
}

// connPool holds reusable TCP/TLS connections for a single upstream address.
type connPool struct {
	client              *dns.Client
	addr                string
	ch                  chan *pooledConn
	idleTimeout         time.Duration // 0 = no limit
	validateBeforeReuse bool
	drained             atomic.Bool   // set when drainConnPool is called; putConn closes conn instead of returning to pool
}

func newConnPool(client *dns.Client, addr string, idleTimeout time.Duration, validateBeforeReuse bool) *connPool {
	return &connPool{
		client:              client,
		addr:                addr,
		ch:                  make(chan *pooledConn, connPoolSize),
		idleTimeout:         idleTimeout,
		validateBeforeReuse: validateBeforeReuse,
	}
}

// isRetriableError returns true if the error suggests a stale/closed connection
// that may succeed with a fresh connection (EOF, write errors, connection reset).
func isRetriableError(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	// EOF: connection closed by remote
	if errors.Is(err, io.EOF) {
		return true
	}
	// Common stale-connection errors
	return strings.Contains(s, "EOF") ||
		strings.Contains(s, "write:") ||
		strings.Contains(s, "broken pipe") ||
		strings.Contains(s, "connection reset") ||
		strings.Contains(s, "connection refused") ||
		strings.Contains(s, "use of closed network connection")
}

// validateConn checks if a connection from the pool is still alive.
// Uses a short read with deadline: EOF = dead, timeout = alive.
// If data is read, it is buffered for the next exchange.
func (p *connPool) validateConn(pc *pooledConn) bool {
	if pc == nil || pc.conn == nil || pc.conn.Conn == nil {
		return false
	}
	underlying := pc.conn.Conn
	underlying.SetReadDeadline(time.Now().Add(5 * time.Millisecond))
	buf := make([]byte, 1)
	n, err := underlying.Read(buf)
	underlying.SetReadDeadline(time.Time{}) // clear deadline
	if err != nil {
		if errors.Is(err, io.EOF) {
			return false // connection closed
		}
		// Timeout (ErrDeadlineExceeded) or other: treat as alive
		if errors.Is(err, os.ErrDeadlineExceeded) {
			return true
		}
		var netErr *net.OpError
		if errors.As(err, &netErr) && netErr.Err != nil && errors.Is(netErr.Err, os.ErrDeadlineExceeded) {
			return true
		}
		// Conservative: unknown errors treated as alive to avoid discarding good conns
		return true
	}
	if n > 0 {
		// Consumed a byte; wrap conn with buffer so next read gets it first
		pc.conn.Conn = &peekBackConn{Conn: underlying, peeked: buf[:n]}
	}
	return true
}

// peekBackConn wraps net.Conn to return previously read bytes before reading from underlying.
type peekBackConn struct {
	net.Conn
	peeked []byte
	reader *bufio.Reader
}

func (p *peekBackConn) Read(b []byte) (n int, err error) {
	if len(p.peeked) > 0 {
		n = copy(b, p.peeked)
		p.peeked = p.peeked[n:]
		return n, nil
	}
	if p.reader == nil {
		p.reader = bufio.NewReader(p.Conn)
	}
	return p.reader.Read(b)
}

// exchange gets a conn (from pool or new), performs the exchange, and returns the conn to the pool.
// On retriable errors (EOF, write) from a pooled conn, retries once with a fresh connection.
func (p *connPool) exchange(ctx context.Context, req *dns.Msg) (*dns.Msg, time.Duration, error) {
	conn, fromPool := p.getConn(ctx)
	if conn == nil {
		return nil, 0, context.DeadlineExceeded
	}
	resp, rtt, err := p.client.ExchangeWithConnContext(ctx, req, conn)
	if err != nil && fromPool && isRetriableError(err) {
		// Stale pooled connection; retry with fresh
		if conn != nil {
			conn.Close()
		}
		conn, err = p.client.DialContext(ctx, p.addr)
		if err != nil {
			return nil, rtt, err
		}
		resp, rtt, err = p.client.ExchangeWithConnContext(ctx, req, conn)
		if err != nil {
			conn.Close()
			return nil, rtt, err
		}
		p.putConn(conn, false, false)
		return resp, rtt, nil
	}
	p.putConn(conn, err != nil, fromPool)
	return resp, rtt, err
}

func (p *connPool) getConn(ctx context.Context) (*dns.Conn, bool) {
	select {
	case pc := <-p.ch:
		if pc == nil || pc.conn == nil {
			return nil, false
		}
		// Idle timeout: don't reuse if sitting too long
		if p.idleTimeout > 0 && time.Since(pc.idleSince) > p.idleTimeout {
			pc.conn.Close()
			// Fall through to dial fresh
		} else if p.validateBeforeReuse && !p.validateConn(pc) {
			pc.conn.Close()
			// Fall through to dial fresh
		} else {
			return pc.conn, true
		}
	default:
	}
	conn, err := p.client.DialContext(ctx, p.addr)
	if err != nil {
		return nil, false
	}
	return conn, false
}

func (p *connPool) putConn(conn *dns.Conn, hadError bool, fromPool bool) {
	if hadError || conn == nil {
		if conn != nil {
			conn.Close()
		}
		return
	}
	// After drain, do not return conn to pool; close it to avoid leaking into discarded pool.
	if p.drained.Load() {
		conn.Close()
		return
	}
	pc := &pooledConn{conn: conn, idleSince: time.Now()}
	select {
	case p.ch <- pc:
	default:
		conn.Close()
	}
}

// drainConnPool closes all connections in the pool. Call before discarding the pool.
// Sets drained flag so concurrent putConn calls close connections instead of returning them.
func drainConnPool(p *connPool) {
	p.drained.Store(true)
	for {
		select {
		case pc := <-p.ch:
			if pc != nil && pc.conn != nil {
				pc.conn.Close()
			}
		default:
			return
		}
	}
}
