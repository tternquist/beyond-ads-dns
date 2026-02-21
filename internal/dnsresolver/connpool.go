package dnsresolver

import (
	"context"
	"sync"
	"time"

	"github.com/miekg/dns"
)

const (
	connPoolSize = 10 // max idle conns per upstream address
)

// connPool holds reusable TCP/TLS connections for a single upstream address.
type connPool struct {
	client *dns.Client
	addr   string
	ch     chan *dns.Conn
	mu     sync.Mutex
}

func newConnPool(client *dns.Client, addr string) *connPool {
	return &connPool{
		client: client,
		addr:  addr,
		ch:    make(chan *dns.Conn, connPoolSize),
	}
}

// exchange gets a conn (from pool or new), performs the exchange, and returns the conn to the pool.
func (p *connPool) exchange(ctx context.Context, req *dns.Msg) (*dns.Msg, time.Duration, error) {
	conn, fromPool := p.getConn(ctx)
	if conn == nil {
		return nil, 0, context.DeadlineExceeded
	}
	resp, rtt, err := p.client.ExchangeWithConnContext(ctx, req, conn)
	p.putConn(conn, err != nil, fromPool)
	return resp, rtt, err
}

func (p *connPool) getConn(ctx context.Context) (*dns.Conn, bool) {
	select {
	case conn := <-p.ch:
		return conn, true
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
	select {
	case p.ch <- conn:
	default:
		conn.Close()
	}
}

// drainConnPool closes all connections in the pool. Call before discarding the pool.
func drainConnPool(p *connPool) {
	for {
		select {
		case conn := <-p.ch:
			if conn != nil {
				conn.Close()
			}
		default:
			return
		}
	}
}
