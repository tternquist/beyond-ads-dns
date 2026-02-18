package main

import (
	"bufio"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

func main() {
	// Handle set-admin-password subcommand (must run before flag.Parse)
	if len(os.Args) >= 2 && os.Args[1] == "set-admin-password" {
		if err := runSetAdminPassword(os.Args[2:]); err != nil {
			slog.Default().Error("set-admin-password failed", "err", err)
			os.Exit(1)
		}
		os.Exit(0)
	}

	defaultConfig := os.Getenv("CONFIG_PATH")
	if defaultConfig == "" {
		defaultConfig = "config/config.yaml"
	}
	configPath := flag.String("config", defaultConfig, "Path to YAML config")
	flag.Parse()

	if err := runServer(*configPath); err != nil {
		slog.Default().Error("failed to run server", "err", err)
		os.Exit(1)
	}
}

func runSetAdminPassword(args []string) error {
	var password string
	if len(args) >= 1 && args[0] != "" {
		password = strings.TrimSpace(args[0])
	}
	if password == "" {
		fmt.Print("Enter admin password: ")
		scanner := bufio.NewScanner(os.Stdin)
		if !scanner.Scan() {
			return fmt.Errorf("no password provided")
		}
		password = strings.TrimSpace(scanner.Text())
		if password == "" {
			return fmt.Errorf("password cannot be empty")
		}
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	path := os.Getenv("ADMIN_PASSWORD_FILE")
	if path == "" {
		path = "/app/config-overrides/.admin-password"
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create directory %s: %w", dir, err)
	}
	if err := os.WriteFile(path, hash, 0600); err != nil {
		return fmt.Errorf("write password file: %w", err)
	}
	fmt.Printf("Admin password set successfully. Password file: %s\n", path)
	return nil
}
