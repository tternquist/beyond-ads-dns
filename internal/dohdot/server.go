package dohdot

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/miekg/dns"
	"log/slog"
)

const (
	defaultDoHPath = "/dns-query"
	doHTimeout     = 30 * time.Second
	dnsMsgMaxSize  = 65535
)

// Handler resolves DNS queries. Same interface as dns.Handler.
type Handler interface {
	ServeDNS(w dns.ResponseWriter, r *dns.Msg)
}

// DoTServer runs a DNS-over-TLS server on the given address.
func DoTServer(ctx context.Context, listenAddr, certFile, keyFile string, handler Handler, logger *slog.Logger) error {
	if listenAddr == "" || certFile == "" || keyFile == "" {
		return nil
	}
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return err
	}
	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	}
	server := &dns.Server{
		Addr:      listenAddr,
		Net:       "tcp-tls",
		TLSConfig: tlsConfig,
		Handler:   handler,
	}
	go func() {
		<-ctx.Done()
		_ = server.Shutdown()
	}()
	if logger != nil {
		logger.Info("DoT server listening", "addr", listenAddr)
	}
	return server.ListenAndServe()
}

// DoHHandler returns an http.Handler for DNS-over-HTTPS (RFC 8484).
// Supports GET ?dns=<base64url> and POST application/dns-message.
// Path defaults to /dns-query if empty.
func DoHHandler(handler Handler, path string) http.Handler {
	if path == "" {
		path = defaultDoHPath
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != path {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var raw []byte
		var err error
		if r.Method == http.MethodGet {
			raw, err = base64.RawURLEncoding.DecodeString(r.URL.Query().Get("dns"))
		} else {
			raw, err = io.ReadAll(io.LimitReader(r.Body, dnsMsgMaxSize))
			r.Body.Close()
		}
		if err != nil || len(raw) == 0 {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		req := new(dns.Msg)
		if err := req.Unpack(raw); err != nil {
			http.Error(w, "invalid dns message", http.StatusBadRequest)
			return
		}

		rw := &doHResponseWriter{req: req, remoteAddr: r.RemoteAddr}
		handler.ServeDNS(rw, req)
		if rw.written == nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		packed, err := rw.written.Pack()
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/dns-message")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(packed)
	})
}

type doHResponseWriter struct {
	req        *dns.Msg
	written    *dns.Msg
	remoteAddr string
}

func (w *doHResponseWriter) LocalAddr() net.Addr { return &net.TCPAddr{} }
func (w *doHResponseWriter) RemoteAddr() net.Addr {
	if w.remoteAddr == "" {
		return &net.TCPAddr{}
	}
	host, port, err := net.SplitHostPort(w.remoteAddr)
	if err != nil {
		host = w.remoteAddr
		port = "0"
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return &net.TCPAddr{}
	}
	portNum := 0
	if p, err := strconv.Atoi(port); err == nil && p >= 0 && p <= 65535 {
		portNum = p
	}
	return &net.TCPAddr{IP: ip, Port: portNum}
}
func (w *doHResponseWriter) WriteMsg(m *dns.Msg) error          { w.written = m; return nil }
func (w *doHResponseWriter) Write([]byte) (int, error)           { return 0, nil }
func (w *doHResponseWriter) Close() error                       { return nil }
func (w *doHResponseWriter) TsigStatus() error                  { return nil }
func (w *doHResponseWriter) TsigTimersOnly(bool)                {}
func (w *doHResponseWriter) Hijack()                            {}
