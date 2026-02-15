package errorlog

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// PersistenceConfig configures disk persistence for errors.
type PersistenceConfig struct {
	RetentionDays  int
	Directory      string
	FilenamePrefix string
}

// ErrorEntry holds a single error with its timestamp.
type ErrorEntry struct {
	Message   string `json:"message"`
	Timestamp string `json:"timestamp"` // RFC3339
}

// Persister handles loading and appending errors to disk.
type Persister struct {
	cfg     PersistenceConfig
	mu      sync.RWMutex
	entries []ErrorEntry
	file    *os.File
}

// NewPersister creates a Persister that loads existing errors from disk
// and appends new ones. Retention is applied when reading.
func NewPersister(cfg PersistenceConfig) (*Persister, error) {
	if cfg.RetentionDays <= 0 {
		cfg.RetentionDays = 7
	}
	if cfg.Directory == "" {
		cfg.Directory = "logs"
	}
	if cfg.FilenamePrefix == "" {
		cfg.FilenamePrefix = "errors"
	}
	p := &Persister{cfg: cfg}
	if err := p.load(); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *Persister) filePath() string {
	return filepath.Join(p.cfg.Directory, p.cfg.FilenamePrefix+".jsonl")
}

func (p *Persister) load() error {
	path := p.filePath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read error log: %w", err)
	}
	cutoff := time.Now().AddDate(0, 0, -p.cfg.RetentionDays)
	var entries []ErrorEntry
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var e ErrorEntry
		if err := json.Unmarshal(line, &e); err != nil {
			continue
		}
		t, err := time.Parse(time.RFC3339, e.Timestamp)
		if err != nil {
			continue
		}
		if t.Before(cutoff) {
			continue
		}
		entries = append(entries, e)
	}
	p.mu.Lock()
	p.entries = entries
	p.mu.Unlock()
	return nil
}

func (p *Persister) ensureFile() error {
	if p.file != nil {
		return nil
	}
	if err := os.MkdirAll(p.cfg.Directory, 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(p.filePath(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	p.file = f
	return nil
}

// Append adds an error and persists it to disk.
func (p *Persister) Append(message string) error {
	entry := ErrorEntry{
		Message:   message,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.ensureFile(); err != nil {
		return err
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	if _, err := p.file.Write(append(line, '\n')); err != nil {
		return err
	}
	p.entries = append(p.entries, entry)
	// Trim in-memory to retention
	p.pruneLocked()
	return nil
}

func (p *Persister) pruneLocked() {
	cutoff := time.Now().AddDate(0, 0, -p.cfg.RetentionDays)
	keep := 0
	for _, e := range p.entries {
		t, err := time.Parse(time.RFC3339, e.Timestamp)
		if err == nil && !t.Before(cutoff) {
			p.entries[keep] = e
			keep++
		}
	}
	p.entries = p.entries[:keep]
}

// Entries returns errors within the retention period, newest last.
func (p *Persister) Entries() []ErrorEntry {
	p.mu.RLock()
	defer p.mu.RUnlock()
	cutoff := time.Now().AddDate(0, 0, -p.cfg.RetentionDays)
	var out []ErrorEntry
	for _, e := range p.entries {
		t, err := time.Parse(time.RFC3339, e.Timestamp)
		if err == nil && !t.Before(cutoff) {
			out = append(out, e)
		}
	}
	return out
}

// Close closes the file handle.
func (p *Persister) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.file != nil {
		err := p.file.Close()
		p.file = nil
		return err
	}
	return nil
}
