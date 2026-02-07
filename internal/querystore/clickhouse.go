package querystore

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type ClickHouseStore struct {
	client        *http.Client
	baseURL       string
	database      string
	table         string
	flushInterval time.Duration
	batchSize     int
	ch            chan Event
	done          chan struct{}
	logger        *log.Logger
	closeOnce     sync.Once
}

func NewClickHouseStore(baseURL, database, table string, flushInterval time.Duration, batchSize int, logger *log.Logger) (*ClickHouseStore, error) {
	trimmed := strings.TrimRight(baseURL, "/")
	if trimmed == "" {
		return nil, fmt.Errorf("clickhouse base url must not be empty")
	}
	store := &ClickHouseStore{
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
		baseURL:       trimmed,
		database:      database,
		table:         table,
		flushInterval: flushInterval,
		batchSize:     batchSize,
		ch:            make(chan Event, batchSize*2),
		done:          make(chan struct{}),
		logger:        logger,
	}
	if err := store.ping(); err != nil {
		store.logf("clickhouse ping failed (will retry on flush): %v", err)
	}
	go store.loop()
	return store, nil
}

func (s *ClickHouseStore) Record(event Event) {
	if s == nil {
		return
	}
	select {
	case s.ch <- event:
	default:
		s.logf("query store buffer full; dropping event")
	}
}

func (s *ClickHouseStore) Close() error {
	if s == nil {
		return nil
	}
	s.closeOnce.Do(func() {
		close(s.ch)
	})
	<-s.done
	return nil
}

func (s *ClickHouseStore) loop() {
	ticker := time.NewTicker(s.flushInterval)
	defer ticker.Stop()
	batch := make([]Event, 0, s.batchSize)
	for {
		select {
		case event, ok := <-s.ch:
			if !ok {
				s.flush(batch)
				close(s.done)
				return
			}
			batch = append(batch, event)
			if len(batch) >= s.batchSize {
				s.flush(batch)
				batch = batch[:0]
			}
		case <-ticker.C:
			if len(batch) > 0 {
				s.flush(batch)
				batch = batch[:0]
			}
		}
	}
}

func (s *ClickHouseStore) flush(batch []Event) {
	if len(batch) == 0 {
		return
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	for _, event := range batch {
		row := map[string]interface{}{
			"ts":          event.Timestamp.Format("2006-01-02 15:04:05"),
			"client_ip":   event.ClientIP,
			"protocol":    event.Protocol,
			"qname":       event.QName,
			"qtype":       event.QType,
			"qclass":      event.QClass,
			"outcome":     event.Outcome,
			"rcode":       event.RCode,
			"duration_ms": event.DurationMS,
		}
		if err := encoder.Encode(row); err != nil {
			s.logf("failed to encode query event: %v", err)
			return
		}
	}
	query := fmt.Sprintf("INSERT INTO %s.%s FORMAT JSONEachRow", s.database, s.table)
	endpoint := fmt.Sprintf("%s/?query=%s", s.baseURL, url.QueryEscape(query))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &buf)
	if err != nil {
		s.logf("failed to create clickhouse request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		s.logf("failed to write to clickhouse: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		s.logf("clickhouse insert failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
}

func (s *ClickHouseStore) ping() error {
	endpoint := fmt.Sprintf("%s/?query=SELECT%%201", s.baseURL)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("clickhouse ping failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

func (s *ClickHouseStore) logf(format string, args ...interface{}) {
	if s.logger == nil {
		return
	}
	s.logger.Printf(format, args...)
}
