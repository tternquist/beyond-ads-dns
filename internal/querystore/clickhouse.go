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
	"sync/atomic"
	"time"

	"github.com/tternquist/beyond-ads-dns/internal/metrics"
)

type ClickHouseStore struct {
	client        *http.Client
	baseURL       string
	database      string
	table         string
	username      string
	password      string
	flushInterval time.Duration
	batchSize     int
	retentionDays int
	ch            chan Event
	done          chan struct{}
	logger        *log.Logger
	closeOnce     sync.Once
	droppedEvents uint64 // Counter for dropped events
	totalRecorded uint64 // Counter for total events recorded
}


func NewClickHouseStore(baseURL, database, table, username, password string, flushInterval time.Duration, batchSize int, retentionDays int, logger *log.Logger) (*ClickHouseStore, error) {
	trimmed := strings.TrimRight(baseURL, "/")
	if trimmed == "" {
		return nil, fmt.Errorf("clickhouse base url must not be empty")
	}
	
	// Calculate buffer size to handle high-throughput L0 cache
	// Target: handle 100K queries/second with 5s flush interval = 500K events
	// Use max of (batchSize * 100) or 50000 to ensure adequate buffering
	bufferSize := batchSize * 100
	if bufferSize < 50000 {
		bufferSize = 50000
	}
	
	// Use bounded Transport to prevent connection accumulation (bufio readers per conn).
	transport := &http.Transport{
		MaxIdleConns:        10,
		MaxIdleConnsPerHost: 2,
		MaxConnsPerHost:     10,
		IdleConnTimeout:     90 * time.Second,
	}
	store := &ClickHouseStore{
		client: &http.Client{
			Timeout:   5 * time.Second,
			Transport: transport,
		},
		baseURL:       trimmed,
		database:      database,
		table:         table,
		username:      username,
		password:      password,
		flushInterval: flushInterval,
		batchSize:     batchSize,
		retentionDays: retentionDays,
		ch:            make(chan Event, bufferSize),
		done:          make(chan struct{}),
		logger:        logger,
	}
	if err := store.ping(); err != nil {
		store.logf("clickhouse ping failed (will retry on flush): %v", err)
	}
	if err := store.ensureSchema(database, table, retentionDays); err != nil {
		store.logf("clickhouse schema init failed: %v", err)
	}
	if err := store.setTTL(); err != nil {
		store.logf("failed to set TTL (table may not exist yet): %v", err)
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
		atomic.AddUint64(&s.totalRecorded, 1)
		metrics.RecordQuerystoreRecorded()
	default:
		dropped := atomic.AddUint64(&s.droppedEvents, 1)
		metrics.RecordQuerystoreDropped()
		// Log every 1000th dropped event to avoid log spam
		if dropped%1000 == 0 {
			s.logf("query store buffer full; %d events dropped total", dropped)
		}
	}
}

// Stats returns statistics about the query store
func (s *ClickHouseStore) Stats() StoreStats {
	if s == nil {
		return StoreStats{}
	}
	return StoreStats{
		BufferSize:    cap(s.ch),
		BufferUsed:    len(s.ch),
		DroppedEvents: atomic.LoadUint64(&s.droppedEvents),
		TotalRecorded: atomic.LoadUint64(&s.totalRecorded),
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
			"ts":                event.Timestamp.Format("2006-01-02 15:04:05"),
			"client_ip":         event.ClientIP,
			"protocol":          event.Protocol,
			"qname":             event.QName,
			"qtype":             event.QType,
			"qclass":            event.QClass,
			"outcome":           event.Outcome,
			"rcode":             event.RCode,
			"duration_ms":       event.DurationMS,
			"cache_lookup_ms":   event.CacheLookupMS,
			"network_write_ms":  event.NetworkWriteMS,
			"upstream_address":  event.UpstreamAddress,
		}
		if err := encoder.Encode(row); err != nil {
			s.logf("failed to encode query event: %v", err)
			return
		}
	}
	query := fmt.Sprintf("INSERT INTO %s.%s FORMAT JSONEachRow", s.database, s.table)
	endpoint, err := s.buildURL(query)
	if err != nil {
		s.logf("failed to build clickhouse url: %v", err)
		return
	}
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
	// Always drain the body to allow connection reuse. Without this, connections
	// accumulate and cannot be returned to the pool, causing memory growth over time.
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		s.logf("clickhouse insert failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	} else {
		_, _ = io.Copy(io.Discard, resp.Body)
	}
}

func (s *ClickHouseStore) ping() error {
	endpoint, err := s.buildURL("SELECT 1")
	if err != nil {
		return err
	}
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

func (s *ClickHouseStore) ensureSchema(database, table string, retentionDays int) error {
	if retentionDays <= 0 {
		retentionDays = 7
	}
	createDB := fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s", database)
	if err := s.execQuery(createDB); err != nil {
		return fmt.Errorf("create database: %w", err)
	}
	createTable := fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s.%s
(
    ts DateTime,
    client_ip String,
    protocol LowCardinality(String),
    qname String,
    qtype LowCardinality(String),
    qclass LowCardinality(String),
    outcome LowCardinality(String),
    rcode LowCardinality(String),
    duration_ms Float64,
    cache_lookup_ms Float64 DEFAULT 0,
    network_write_ms Float64 DEFAULT 0,
    upstream_address LowCardinality(String) DEFAULT ''
)
ENGINE = MergeTree
ORDER BY (ts, qname)
TTL ts + INTERVAL %d DAY`, database, table, retentionDays)
	if err := s.execQuery(createTable); err != nil {
		return fmt.Errorf("create table: %w", err)
	}
	return nil
}

func (s *ClickHouseStore) execQuery(query string) error {
	endpoint, err := s.buildURL(query)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
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
		return fmt.Errorf("status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

func (s *ClickHouseStore) setTTL() error {
	query := fmt.Sprintf("ALTER TABLE %s.%s MODIFY TTL ts + INTERVAL %d DAY", s.database, s.table, s.retentionDays)
	endpoint, err := s.buildURL(query)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
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
		return fmt.Errorf("clickhouse set TTL failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	s.logf("set query retention to %d days", s.retentionDays)
	return nil
}

func (s *ClickHouseStore) buildURL(query string) (string, error) {
	parsed, err := url.Parse(s.baseURL)
	if err != nil {
		return "", err
	}
	values := parsed.Query()
	values.Set("query", query)
	if s.username != "" {
		values.Set("user", s.username)
	}
	if s.password != "" {
		values.Set("password", s.password)
	}
	parsed.RawQuery = values.Encode()
	return parsed.String(), nil
}

func (s *ClickHouseStore) logf(format string, args ...interface{}) {
	if s.logger == nil {
		return
	}
	s.logger.Printf(format, args...)
}
