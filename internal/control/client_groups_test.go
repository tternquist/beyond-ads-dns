package control

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// --- handleClientGroupsCRUD ---

func TestHandleClientGroupsCRUD_MissingConfigPath(t *testing.T) {
	handler := handleClientGroupsCRUD(nil, "", "")
	req := httptest.NewRequest(http.MethodGet, "/client-groups", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestHandleClientGroupsCRUD_Unauthorized(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientGroupsCRUD(nil, cfgPath, "secret")
	req := httptest.NewRequest(http.MethodGet, "/client-groups", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestHandleClientGroupsCRUD_AuthorizedWithBearerToken(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`server:
  listen: ["127.0.0.1:53"]
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientGroupsCRUD(nil, cfgPath, "my-token")
	req := httptest.NewRequest(http.MethodGet, "/client-groups", nil)
	req.Header.Set("Authorization", "Bearer my-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 with valid token, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandleClientGroupsCRUD_MethodNotAllowed(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientGroupsCRUD(nil, cfgPath, "")
	req := httptest.NewRequest(http.MethodDelete, "/client-groups", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", rec.Code)
	}
}

func TestHandleClientGroupsList_EmptyConfig(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`server:
  listen: ["127.0.0.1:53"]
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientGroupsCRUD(nil, cfgPath, "")
	req := httptest.NewRequest(http.MethodGet, "/client-groups", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	groups, _ := body["client_groups"].([]any)
	if groups == nil {
		t.Errorf("expected client_groups array in response, got %v", body)
	}
}

func TestHandleClientGroupsCreateOrUpdate_InvalidJSON(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientGroupsCRUD(nil, cfgPath, "")
	req := httptest.NewRequest(http.MethodPost, "/client-groups", bytes.NewBufferString(`{invalid`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid JSON, got %d", rec.Code)
	}
}

func TestHandleClientGroupsCreateOrUpdate_MissingID(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientGroupsCRUD(nil, cfgPath, "")
	req := httptest.NewRequest(http.MethodPost, "/client-groups",
		bytes.NewBufferString(`{"name": "Kids"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 when id is missing, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if errMsg, _ := body["error"].(string); errMsg == "" {
		t.Errorf("expected error message, got %v", body)
	}
}

func TestHandleClientGroupsCreateOrUpdate_CreatesNewGroup(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`server:
  listen: ["127.0.0.1:53"]
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientGroupsCRUD(nil, cfgPath, "")

	payload := `{"id": "kids", "name": "Kids", "description": "Children devices"}`
	req := httptest.NewRequest(http.MethodPost, "/client-groups", bytes.NewBufferString(payload))
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
}

func TestHandleClientGroupsCreateOrUpdate_UpdatesExistingGroup(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`server:
  listen: ["127.0.0.1:53"]
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientGroupsCRUD(nil, cfgPath, "")

	// Create
	createReq := httptest.NewRequest(http.MethodPost, "/client-groups",
		bytes.NewBufferString(`{"id": "kids", "name": "Kids"}`))
	handler.ServeHTTP(httptest.NewRecorder(), createReq)

	// Update with new name
	updateReq := httptest.NewRequest(http.MethodPost, "/client-groups",
		bytes.NewBufferString(`{"id": "kids", "name": "Children", "description": "Updated"}`))
	updateRec := httptest.NewRecorder()
	handler.ServeHTTP(updateRec, updateReq)

	if updateRec.Code != http.StatusOK {
		t.Errorf("expected 200 on update, got %d: %s", updateRec.Code, updateRec.Body.String())
	}
}

func TestHandleClientGroupsCreateOrUpdate_DefaultsNameToID(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`server:
  listen: ["127.0.0.1:53"]
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientGroupsCRUD(nil, cfgPath, "")

	// Name omitted — should default to the id value
	payload := `{"id": "work"}`
	req := httptest.NewRequest(http.MethodPost, "/client-groups", bytes.NewBufferString(payload))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandleClientGroupsCreateOrUpdate_DisableCacheRoundTripAndClear(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`server:
  listen: ["127.0.0.1:53"]
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientGroupsCRUD(nil, cfgPath, "")

	post := func(payload string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/client-groups", bytes.NewBufferString(payload))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("POST %s expected 200, got %d: %s", payload, rec.Code, rec.Body.String())
		}
	}
	getGroup := func() map[string]any {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/client-groups", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		var body map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		groups, ok := body["client_groups"].([]any)
		if !ok || len(groups) != 1 {
			t.Fatalf("expected one client group, got %v", body["client_groups"])
		}
		group, ok := groups[0].(map[string]any)
		if !ok {
			t.Fatalf("expected group object, got %T", groups[0])
		}
		return group
	}

	post(`{"id": "kids", "name": "Kids", "disable_cache": true}`)
	group := getGroup()
	if got, ok := group["disable_cache"].(bool); !ok || !got {
		t.Fatalf("disable_cache after true POST = %v, want true", group["disable_cache"])
	}
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if !strings.Contains(string(data), "disable_cache: true") {
		t.Fatalf("override should persist disable_cache: true, got:\n%s", string(data))
	}

	post(`{"id": "kids", "name": "Kids", "disable_cache": false}`)
	group = getGroup()
	if got, ok := group["disable_cache"].(bool); !ok || got {
		t.Fatalf("disable_cache after false POST = %v, want false", group["disable_cache"])
	}

	post(`{"id": "kids", "name": "Kids"}`)
	group = getGroup()
	if _, exists := group["disable_cache"]; exists {
		t.Fatalf("disable_cache should be omitted after update without field, got %v", group)
	}
}

// --- handleClientGroupsDeleteHandler ---

func TestHandleClientGroupsDelete_MethodNotAllowed(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientGroupsDeleteHandler(nil, cfgPath, "")
	req := httptest.NewRequest(http.MethodGet, "/client-groups/kids", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", rec.Code)
	}
}

func TestHandleClientGroupsDelete_MissingID(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientGroupsDeleteHandler(nil, cfgPath, "")
	req := httptest.NewRequest(http.MethodDelete, "/client-groups/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 when ID is missing, got %d", rec.Code)
	}
}

func TestHandleClientGroupsDelete_CannotDeleteDefault(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientGroupsDeleteHandler(nil, cfgPath, "")
	req := httptest.NewRequest(http.MethodDelete, "/client-groups/default", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 when deleting default group, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if errMsg, _ := body["error"].(string); errMsg == "" {
		t.Errorf("expected error message for default group deletion, got %v", body)
	}
}

func TestHandleClientGroupsDelete_RemovesGroup(t *testing.T) {
	defaultPath := writeTempConfig(t, []byte(`server:
  listen: ["127.0.0.1:53"]
`))
	os.Setenv("DEFAULT_CONFIG_PATH", defaultPath)
	defer os.Unsetenv("DEFAULT_CONFIG_PATH")

	cfgPath := writeTempConfig(t, []byte(``))
	crudHandler := handleClientGroupsCRUD(nil, cfgPath, "")
	deleteHandler := handleClientGroupsDeleteHandler(nil, cfgPath, "")

	// Create a group
	createReq := httptest.NewRequest(http.MethodPost, "/client-groups",
		bytes.NewBufferString(`{"id": "kids", "name": "Kids"}`))
	crudHandler.ServeHTTP(httptest.NewRecorder(), createReq)

	// Delete it
	delReq := httptest.NewRequest(http.MethodDelete, "/client-groups/kids", nil)
	delRec := httptest.NewRecorder()
	deleteHandler.ServeHTTP(delRec, delReq)

	if delRec.Code != http.StatusOK {
		t.Errorf("expected 200 on delete, got %d: %s", delRec.Code, delRec.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(delRec.Body).Decode(&body); err != nil {
		t.Fatalf("decode delete response: %v", err)
	}
	if body["ok"] != true {
		t.Errorf("expected ok: true, got %v", body)
	}
}

func TestHandleClientGroupsDelete_Unauthorized(t *testing.T) {
	cfgPath := writeTempConfig(t, []byte(``))
	handler := handleClientGroupsDeleteHandler(nil, cfgPath, "secret")
	req := httptest.NewRequest(http.MethodDelete, "/client-groups/kids", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestHandleClientGroupsDelete_MissingConfigPath(t *testing.T) {
	handler := handleClientGroupsDeleteHandler(nil, "", "")
	req := httptest.NewRequest(http.MethodDelete, "/client-groups/kids", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 when configPath is empty, got %d", rec.Code)
	}
}
