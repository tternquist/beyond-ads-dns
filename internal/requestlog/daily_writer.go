package requestlog

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type DailyWriter struct {
	dir         string
	prefix      string
	currentDate string
	file        *os.File
	mu          sync.Mutex
}

func NewDailyWriter(dir, prefix string) (*DailyWriter, error) {
	if dir == "" {
		dir = "logs"
	}
	if prefix == "" {
		prefix = "dns-requests"
	}
	writer := &DailyWriter{
		dir:    dir,
		prefix: prefix,
	}
	if err := writer.rotateIfNeeded(time.Now()); err != nil {
		return nil, err
	}
	return writer, nil
}

func (w *DailyWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.rotateIfNeeded(time.Now()); err != nil {
		return 0, err
	}
	return w.file.Write(p)
}

func (w *DailyWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

func (w *DailyWriter) rotateIfNeeded(now time.Time) error {
	date := now.Format("2006-01-02")
	if date == w.currentDate && w.file != nil {
		return nil
	}
	if err := os.MkdirAll(w.dir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(w.dir, fmt.Sprintf("%s-%s.log", w.prefix, date))
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if w.file != nil {
		_ = w.file.Close()
	}
	w.file = file
	w.currentDate = date
	return nil
}
