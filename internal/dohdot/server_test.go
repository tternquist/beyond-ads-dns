package dohdot

import (
	"bytes"
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/miekg/dns"
)

type mockHandler struct {
	serveCount int
}

func (m *mockHandler) ServeDNS(w dns.ResponseWriter, r *dns.Msg) {
	m.serveCount++
	resp := new(dns.Msg)
	resp.SetReply(r)
	resp.Answer = append(resp.Answer, &dns.A{
		Hdr: dns.RR_Header{Name: r.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
		A:   []byte{1, 2, 3, 4},
	})
	_ = w.WriteMsg(resp)
}

func TestDoHHandler_GET_ValidQuery(t *testing.T) {
	mock := &mockHandler{}
	handler := DoHHandler(mock, "/dns-query")

	msg := new(dns.Msg)
	msg.SetQuestion("example.com.", dns.TypeA)
	packed, _ := msg.Pack()
	b64 := base64.RawURLEncoding.EncodeToString(packed)

	req := httptest.NewRequest(http.MethodGet, "/dns-query?dns="+b64, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Content-Type") != "application/dns-message" {
		t.Errorf("expected Content-Type application/dns-message, got %s", rec.Header().Get("Content-Type"))
	}
	if mock.serveCount != 1 {
		t.Errorf("expected handler to be called once, got %d", mock.serveCount)
	}
	// Verify response is valid DNS
	resp := new(dns.Msg)
	if err := resp.Unpack(rec.Body.Bytes()); err != nil {
		t.Errorf("response not valid DNS: %v", err)
	}
}

func TestDoHHandler_POST_ValidQuery(t *testing.T) {
	mock := &mockHandler{}
	handler := DoHHandler(mock, "/dns-query")

	msg := new(dns.Msg)
	msg.SetQuestion("test.example.com.", dns.TypeAAAA)
	packed, _ := msg.Pack()

	req := httptest.NewRequest(http.MethodPost, "/dns-query", bytes.NewReader(packed))
	req.Header.Set("Content-Type", "application/dns-message")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if mock.serveCount != 1 {
		t.Errorf("expected handler to be called once, got %d", mock.serveCount)
	}
}

func TestDoHHandler_DefaultPath(t *testing.T) {
	mock := &mockHandler{}
	handler := DoHHandler(mock, "")

	msg := new(dns.Msg)
	msg.SetQuestion("example.com.", dns.TypeA)
	packed, _ := msg.Pack()
	b64 := base64.RawURLEncoding.EncodeToString(packed)

	req := httptest.NewRequest(http.MethodGet, "/dns-query?dns="+b64, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 with default path, got %d", rec.Code)
	}
}

func TestDoHHandler_WrongPath(t *testing.T) {
	mock := &mockHandler{}
	handler := DoHHandler(mock, "/dns-query")

	req := httptest.NewRequest(http.MethodGet, "/other-path", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rec.Code)
	}
	if mock.serveCount != 0 {
		t.Errorf("handler should not be called for wrong path, got %d", mock.serveCount)
	}
}

func TestDoHHandler_MethodNotAllowed(t *testing.T) {
	mock := &mockHandler{}
	handler := DoHHandler(mock, "/dns-query")

	req := httptest.NewRequest(http.MethodPut, "/dns-query", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", rec.Code)
	}
	if allow := rec.Header().Get("Allow"); allow != "GET, POST" {
		t.Errorf("expected Allow: GET, POST, got %s", allow)
	}
}

func TestDoHHandler_GET_InvalidBase64(t *testing.T) {
	mock := &mockHandler{}
	handler := DoHHandler(mock, "/dns-query")

	req := httptest.NewRequest(http.MethodGet, "/dns-query?dns=not-valid-base64!!!", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestDoHHandler_GET_EmptyQuery(t *testing.T) {
	mock := &mockHandler{}
	handler := DoHHandler(mock, "/dns-query")

	req := httptest.NewRequest(http.MethodGet, "/dns-query?dns=", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestDoHHandler_POST_InvalidDNS(t *testing.T) {
	mock := &mockHandler{}
	handler := DoHHandler(mock, "/dns-query")

	req := httptest.NewRequest(http.MethodPost, "/dns-query", bytes.NewReader([]byte{0, 1, 2, 3}))
	req.Header.Set("Content-Type", "application/dns-message")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestDoHResponseWriter_RemoteAddr(t *testing.T) {
	w := &doHResponseWriter{remoteAddr: "192.168.1.1:12345"}
	addr := w.RemoteAddr()
	if addr == nil {
		t.Fatal("RemoteAddr returned nil")
	}
	tcpAddr, ok := addr.(*net.TCPAddr)
	if !ok {
		t.Fatalf("expected *net.TCPAddr, got %T", addr)
	}
	if tcpAddr.IP.String() != "192.168.1.1" {
		t.Errorf("IP = %s, want 192.168.1.1", tcpAddr.IP)
	}
	if tcpAddr.Port != 12345 {
		t.Errorf("Port = %d, want 12345", tcpAddr.Port)
	}
}

func TestDoHResponseWriter_RemoteAddr_Empty(t *testing.T) {
	w := &doHResponseWriter{remoteAddr: ""}
	addr := w.RemoteAddr()
	if addr == nil {
		t.Fatal("RemoteAddr returned nil")
	}
}

func TestDoHResponseWriter_RemoteAddr_InvalidPort(t *testing.T) {
	w := &doHResponseWriter{remoteAddr: "192.168.1.1:invalid"}
	addr := w.RemoteAddr()
	if addr == nil {
		t.Fatal("RemoteAddr returned nil")
	}
}
