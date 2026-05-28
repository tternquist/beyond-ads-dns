package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestRunSetAdminPassword_FromArg(t *testing.T) {
	// Write into a nested path under a temp dir to also exercise MkdirAll.
	dir := t.TempDir()
	path := filepath.Join(dir, "secrets", ".admin-password")
	t.Setenv("ADMIN_PASSWORD_FILE", path)

	if err := runSetAdminPassword([]string{"hunter2"}); err != nil {
		t.Fatalf("runSetAdminPassword: %v", err)
	}

	hash, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading password file: %v", err)
	}
	if err := bcrypt.CompareHashAndPassword(hash, []byte("hunter2")); err != nil {
		t.Errorf("stored hash does not verify against password: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("password file perms = %o, want 600", perm)
	}
}

func TestRunSetAdminPassword_TrimsWhitespace(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".admin-password")
	t.Setenv("ADMIN_PASSWORD_FILE", path)

	if err := runSetAdminPassword([]string{"  spaced  "}); err != nil {
		t.Fatalf("runSetAdminPassword: %v", err)
	}
	hash, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading password file: %v", err)
	}
	if err := bcrypt.CompareHashAndPassword(hash, []byte("spaced")); err != nil {
		t.Errorf("trimmed password should verify: %v", err)
	}
}

func TestRunSetAdminPassword_EmptyFromStdin(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ADMIN_PASSWORD_FILE", filepath.Join(dir, ".admin-password"))

	// No arg provided and stdin is empty: it should fail rather than write an
	// empty-password file.
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	w.Close() // immediate EOF, no input

	oldStdin := os.Stdin
	os.Stdin = r
	defer func() { os.Stdin = oldStdin }()

	if err := runSetAdminPassword(nil); err == nil {
		t.Error("expected error when no password is provided")
	}
}

func TestRunSetAdminPassword_BlankFromStdin(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ADMIN_PASSWORD_FILE", filepath.Join(dir, ".admin-password"))

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	if _, err := w.WriteString("   \n"); err != nil {
		t.Fatalf("write: %v", err)
	}
	w.Close()

	oldStdin := os.Stdin
	os.Stdin = r
	defer func() { os.Stdin = oldStdin }()

	if err := runSetAdminPassword(nil); err == nil {
		t.Error("expected error when password is blank after trimming")
	}
}
