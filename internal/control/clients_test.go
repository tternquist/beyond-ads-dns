package control

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// --- normalizeClientsToList ---

func TestNormalizeClientsToList_Nil(t *testing.T) {
	got := normalizeClientsToList(nil)
	if len(got) != 0 {
		t.Errorf("expected empty slice for nil input, got %v", got)
	}
}

func TestNormalizeClientsToList_ListFormat(t *testing.T) {
	input := []any{
		map[string]any{"ip": "10.0.0.1", "name": "alice", "group_id": ""},
		map[string]any{"ip": "10.0.0.2", "name": "bob", "group_id": "kids"},
	}
	got := normalizeClientsToList(input)
	if len(got) != 2 {
		t.Fatalf("expected 2 clients, got %d", len(got))
	}
	if got[0]["ip"] != "10.0.0.1" || got[0]["name"] != "alice" {
		t.Errorf("unexpected first client: %v", got[0])
	}
}

func TestNormalizeClientsToList_LegacyMapFormat(t *testing.T) {
	input := map[string]any{
		"10.0.0.1": "alice",
		"10.0.0.2": "bob",
	}
	got := normalizeClientsToList(input)
	if len(got) != 2 {
		t.Fatalf("expected 2 clients, got %d", len(got))
	}
	// Verify each entry has ip and name fields
	for _, c := range got {
		if c["ip"] == "" {
			t.Errorf("expected non-empty ip, got %v", c)
		}
		if c["group_id"] != "" {
			t.Errorf("expected empty group_id for legacy format, got %v", c)
		}
	}
}

func TestNormalizeClientsToList_SkipsNonMapEntries(t *testing.T) {
	input := []any{"not-a-map", 42, map[string]any{"ip": "10.0.0.1", "name": "alice", "group_id": ""}}
	got := normalizeClientsToList(input)
	if len(got) != 1 {
		t.Fatalf("expected 1 valid client, got %d: %v", len(got), got)
	}
}

// --- handleClientsCRUD ---

func TestHandleClientsCRUD_MissingConfigPath(t *testing.T) {
	handler := handleClientsCRUD(nil, "", "")
	req := httptest.NewRequest(http.MethodGet, "/clients", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestHandleClientsCRUD_Unauthorized(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(`server:
  listen: ["127.0.0.1:53"]
`))
	handler := handleClientsCRUD(nil, cfgPath, "secret")
	req := httptest.NewRequest(http.MethodGet, "/clients", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestHandleClientsCRUD_MethodNotAllowed(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(`server:
  listen: ["127.0.0.1:53"]
`))
	handler := handleClientsCRUD(nil, cfgPath, "")
	req := httptest.NewRequest(http.MethodDelete, "/clients", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", rec.Code)
	}
}

func TestHandleClientsList_EmptyConfig(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`server:
  listen: ["127.0.0.1:53"]
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientsCRUD(nil, cfgPath, "")

	req := httptest.NewRequest(http.MethodGet, "/clients", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	clients, _ := body["clients"].([]any)
	if clients == nil {
		t.Errorf("expected clients array in response, got %v", body)
	}
	if len(clients) != 0 {
		t.Errorf("expected empty clients list, got %d entries", len(clients))
	}
}

func TestHandleClientsCreateOrUpdate_InvalidJSON(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientsCRUD(nil, cfgPath, "")

	req := httptest.NewRequest(http.MethodPost, "/clients", bytes.NewBufferString(`{invalid`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid JSON, got %d", rec.Code)
	}
}

func TestHandleClientsCreateOrUpdate_MissingIP(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientsCRUD(nil, cfgPath, "")

	body := `{"name": "alice"}`
	req := httptest.NewRequest(http.MethodPost, "/clients", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 when ip is missing, got %d", rec.Code)
	}
	var respBody map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&respBody); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if errMsg, _ := respBody["error"].(string); errMsg == "" {
		t.Errorf("expected error message, got %v", respBody)
	}
}

func TestHandleClientsCreateOrUpdate_CreatesNewClient(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`server:
  listen: ["127.0.0.1:53"]
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientsCRUD(nil, cfgPath, "")

	payload := `{"ip": "192.168.1.10", "name": "alice", "group_id": ""}`
	req := httptest.NewRequest(http.MethodPost, "/clients", bytes.NewBufferString(payload))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["ok"] != true {
		t.Errorf("expected ok: true, got %v", body)
	}

	// Verify client appears on subsequent GET
	getReq := httptest.NewRequest(http.MethodGet, "/clients", nil)
	getRec := httptest.NewRecorder()
	handler.ServeHTTP(getRec, getReq)
	var getBody map[string]any
	if err := json.NewDecoder(getRec.Body).Decode(&getBody); err != nil {
		t.Fatalf("decode GET response: %v", err)
	}
	clients, _ := getBody["clients"].([]any)
	if len(clients) != 1 {
		t.Errorf("expected 1 client after creation, got %d", len(clients))
	}
}

func TestHandleClientsCreateOrUpdate_UpdatesExistingClient(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`server:
  listen: ["127.0.0.1:53"]
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientsCRUD(nil, cfgPath, "")

	// Create
	createReq := httptest.NewRequest(http.MethodPost, "/clients",
		bytes.NewBufferString(`{"ip": "192.168.1.10", "name": "alice", "group_id": ""}`))
	handler.ServeHTTP(httptest.NewRecorder(), createReq)

	// Update same IP with new name
	updateReq := httptest.NewRequest(http.MethodPost, "/clients",
		bytes.NewBufferString(`{"ip": "192.168.1.10", "name": "alice-updated", "group_id": "kids"}`))
	updateRec := httptest.NewRecorder()
	handler.ServeHTTP(updateRec, updateReq)

	if updateRec.Code != http.StatusOK {
		t.Errorf("expected 200 on update, got %d: %s", updateRec.Code, updateRec.Body.String())
	}

	// GET should still show 1 client with the updated name
	getReq := httptest.NewRequest(http.MethodGet, "/clients", nil)
	getRec := httptest.NewRecorder()
	handler.ServeHTTP(getRec, getReq)
	var getBody map[string]any
	if err := json.NewDecoder(getRec.Body).Decode(&getBody); err != nil {
		t.Fatalf("decode GET response: %v", err)
	}
	clients, _ := getBody["clients"].([]any)
	if len(clients) != 1 {
		t.Errorf("expected 1 client after update, got %d", len(clients))
	}
	client, _ := clients[0].(map[string]any)
	if client["name"] != "alice-updated" {
		t.Errorf("expected name alice-updated, got %v", client["name"])
	}
}

// --- handleClientsDeleteHandler ---

func TestHandleClientsDelete_MethodNotAllowed(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientsDeleteHandler(nil, cfgPath, "")

	req := httptest.NewRequest(http.MethodGet, "/clients/10.0.0.1", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", rec.Code)
	}
}

func TestHandleClientsDelete_MissingIP(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientsDeleteHandler(nil, cfgPath, "")

	req := httptest.NewRequest(http.MethodDelete, "/clients/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 when IP missing, got %d", rec.Code)
	}
}

func TestHandleClientsDelete_RemovesClient(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`server:
  listen: ["127.0.0.1:53"]
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	cfgPath := writeTempConfig(t, []byte(``))
	crudHandler := handleClientsCRUD(nil, cfgPath, "")
	deleteHandler := handleClientsDeleteHandler(nil, cfgPath, "")

	// Create a client
	createReq := httptest.NewRequest(http.MethodPost, "/clients",
		bytes.NewBufferString(`{"ip": "192.168.1.10", "name": "alice", "group_id": ""}`))
	crudHandler.ServeHTTP(httptest.NewRecorder(), createReq)

	// Delete it
	delReq := httptest.NewRequest(http.MethodDelete, "/clients/192.168.1.10", nil)
	delRec := httptest.NewRecorder()
	deleteHandler.ServeHTTP(delRec, delReq)

	if delRec.Code != http.StatusOK {
		t.Errorf("expected 200 on delete, got %d: %s", delRec.Code, delRec.Body.String())
	}

	// Verify client is gone
	getReq := httptest.NewRequest(http.MethodGet, "/clients", nil)
	getRec := httptest.NewRecorder()
	crudHandler.ServeHTTP(getRec, getReq)
	var getBody map[string]any
	if err := json.NewDecoder(getRec.Body).Decode(&getBody); err != nil {
		t.Fatalf("decode GET response: %v", err)
	}
	clients, _ := getBody["clients"].([]any)
	if len(clients) != 0 {
		t.Errorf("expected 0 clients after delete, got %d", len(clients))
	}
}

func TestHandleClientsDelete_Unauthorized(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientsDeleteHandler(nil, cfgPath, "secret")

	req := httptest.NewRequest(http.MethodDelete, "/clients/10.0.0.1", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestHandleClientsDelete_AuthorizedWithToken(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`server:
  listen: ["127.0.0.1:53"]
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientsDeleteHandler(nil, cfgPath, "my-token")

	req := httptest.NewRequest(http.MethodDelete, "/clients/192.168.0.1", nil)
	req.Header.Set("Authorization", "Bearer my-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// No client to delete, but auth should pass (returns 200 ok)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 with valid token, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandleClientsDelete_MissingConfigPath(t *testing.T) {
	handler := handleClientsDeleteHandler(nil, "", "")
	req := httptest.NewRequest(http.MethodDelete, "/clients/10.0.0.1", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 when configPath is empty, got %d", rec.Code)
	}
}
