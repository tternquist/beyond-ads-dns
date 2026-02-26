package querystore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/tternquist/beyond-ads-dns/internal/metrics"
)

// isRetriableConnectionError returns true if the error suggests a transient
// connection issue that may succeed with a fresh connection (e.g. after Docker
// restart, DNS recovery, or brief network outage).
func isRetriableConnectionError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) {
		return true
	}
	s := err.Error()
	return strings.Contains(s, "EOF") ||
		strings.Contains(s, "write:") ||
		strings.Contains(s, "broken pipe") ||
		strings.Contains(s, "connection reset") ||
		strings.Contains(s, "connection refused") ||
		strings.Contains(s, "use of closed network connection") ||
		strings.Contains(s, "i/o timeout") ||
		strings.Contains(s, "context deadline exceeded") ||
		strings.Contains(s, "connection timed out") ||
		strings.Contains(s, "no such host") ||
		strings.Contains(s, "getaddrinfo")
}

// isValidIdentifier validates ClickHouse identifier (database or table name) to prevent SQL injection.
// Matches Node.js validateClickHouseIdentifier: alphanumeric and underscore only, max 256 chars.
func isValidIdentifier(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > 256 {
		return false
	}
	for _, r := range s {
		if !(unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_') {
			return false
		}
	}
	return true
}

// isValidPartitionID validates partition ID format (YYYYMMDD or YYYYMMDDHH) to prevent SQL injection.
func isValidPartitionID(partition string) bool {
	if len(partition) != 8 && len(partition) != 10 {
		return false
	}
	for _, r := range partition {
		if !unicode.IsDigit(r) {
			return false
		}
	}
	return true
}

type ClickHouseStore struct {
	client              *http.Client
	baseURL             string
	database            string
	table               string
	username            string
	password            string
	flushToStoreInterval time.Duration // How often the app sends buffered events to ClickHouse
	flushToDiskInterval  time.Duration // How often ClickHouse flushes async inserts to disk
	batchSize           int
	retentionHours      int // Retention in hours; used for TTL and schema (hourly partitions)
	maxSizeMB           int // 0 = unlimited
	ch            chan Event
	done          chan struct{}
	logger        *slog.Logger
	closeOnce     sync.Once
	droppedEvents   uint64 // Counter for dropped events
	totalRecorded   uint64 // Counter for total events recorded
	flushCount      uint64 // Incremented each flush; enforceMaxSize runs every enforceMaxSizeInterval flushes
}

// enforceMaxSizeInterval: run enforceMaxSize every N flushes (~60s at 5s flush) to reduce system.parts queries
const enforceMaxSizeInterval = 12

// bufferPool reuses bytes.Buffer for flush encoding to reduce allocations at high QPS.
var bufferPool = sync.Pool{
	New: func() any { return &bytes.Buffer{} },
}

// clickHouseRow is a struct for JSON encoding to ClickHouse. Using a struct instead of
// map[string]interface{} avoids reflection type switches and significantly reduces
// encoding overhead at high QPS (see docs/performance-bottleneck-review.md).
type clickHouseRow struct {
	Ts              string  `json:"ts"`
	ClientIP        string  `json:"client_ip"`
	ClientName      string  `json:"client_name"`
	Protocol        string  `json:"protocol"`
	QName           string  `json:"qname"`
	QType           string  `json:"qtype"`
	QClass          string  `json:"qclass"`
	Outcome         string  `json:"outcome"`
	RCode           string  `json:"rcode"`
	DurationMS      float64 `json:"duration_ms"`
	CacheLookupMS   float64 `json:"cache_lookup_ms"`
	NetworkWriteMS  float64 `json:"network_write_ms"`
	UpstreamAddress string  `json:"upstream_address"`
}


func NewClickHouseStore(baseURL, database, table, username, password string, flushToStoreInterval, flushToDiskInterval time.Duration, batchSize int, retentionHours int, maxSizeMB int, logger *slog.Logger) (*ClickHouseStore, error) {
	trimmed := strings.TrimRight(baseURL, "/")
	if trimmed == "" {
		return nil, fmt.Errorf("clickhouse base url must not be empty")
	}
	if !isValidIdentifier(database) {
		return nil, fmt.Errorf("clickhouse database name must be alphanumeric or underscore, 1-256 chars")
	}
	if !isValidIdentifier(table) {
		return nil, fmt.Errorf("clickhouse table name must be alphanumeric or underscore, 1-256 chars")
	}

	// Calculate buffer size to handle high-throughput L0 cache
	// Target: handle 100K queries/second with 5s flush interval = 500K events (buffer caps at batchSize*100)
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
		baseURL:               trimmed,
		database:              database,
		table:                 table,
		username:              username,
		password:              password,
		flushToStoreInterval:  flushToStoreInterval,
		flushToDiskInterval:   flushToDiskInterval,
		batchSize:             batchSize,
		retentionHours:        retentionHours,
		maxSizeMB:             maxSizeMB,
		ch:                    make(chan Event, bufferSize),
		done:                  make(chan struct{}),
		logger:                logger,
	}
	if err := store.ping(); err != nil {
		return nil, fmt.Errorf("clickhouse unreachable: %w", err)
	}
	if err := store.ensureSchema(database, table, retentionHours); err != nil {
		return nil, fmt.Errorf("clickhouse schema init: %w", err)
	}
	if err := store.setTTL(); err != nil {
		store.logf(slog.LevelWarn, "failed to set TTL (table may not exist yet)", "err", err)
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
			s.logf(slog.LevelInfo, "query store buffer full", "dropped_total", dropped)
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
	ticker := time.NewTicker(s.flushToStoreInterval)
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

func isSchemaMissing(body string) bool {
	return strings.Contains(body, "UNKNOWN_DATABASE") ||
		strings.Contains(body, "UNKNOWN_TABLE") ||
		strings.Contains(body, "does not exist")
}

func (s *ClickHouseStore) flush(batch []Event) {
	s.flushInternal(batch, false)
}

func (s *ClickHouseStore) flushInternal(batch []Event, skipReinit bool) {
	if len(batch) == 0 {
		return
	}
	// Enforce max_size_mb before insert: drop oldest partitions until under limit.
	// Run every Nth flush to avoid system.parts query on every 5s cycle.
	if s.maxSizeMB > 0 {
		n := atomic.AddUint64(&s.flushCount, 1)
		if n%enforceMaxSizeInterval == 0 {
			s.enforceMaxSize()
		}
	}
	buf := bufferPool.Get().(*bytes.Buffer)
	buf.Reset()
	defer bufferPool.Put(buf)
	encoder := json.NewEncoder(buf)
	for _, event := range batch {
		row := clickHouseRow{
			Ts:              event.Timestamp.Format("2006-01-02 15:04:05"),
			ClientIP:        event.ClientIP,
			ClientName:       event.ClientName,
			Protocol:         event.Protocol,
			QName:            event.QName,
			QType:            event.QType,
			QClass:           event.QClass,
			Outcome:          event.Outcome,
			RCode:            event.RCode,
			DurationMS:       event.DurationMS,
			CacheLookupMS:    event.CacheLookupMS,
			NetworkWriteMS:   event.NetworkWriteMS,
			UpstreamAddress:  event.UpstreamAddress,
		}
		if err := encoder.Encode(row); err != nil {
			s.logf(slog.LevelError, "failed to encode query event", "err", err)
			return
		}
	}
	query := fmt.Sprintf("INSERT INTO %s.%s FORMAT JSONEachRow", s.database, s.table)
	endpoint, err := s.buildInsertURL(query)
	if err != nil {
		s.logf(slog.LevelError, "failed to build clickhouse url", "err", err)
		return
	}
	body := buf.Bytes()
	var resp *http.Response
	for attempt := 0; attempt < 3; attempt++ {
		// Fresh context per attempt so retries are not bound by a cancelled context
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			cancel()
			s.logf(slog.LevelError, "failed to create clickhouse request", "err", err)
			return
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err = s.client.Do(req)
		cancel()
		if err != nil {
			// Always close idle connections on connection errors so the next flush uses fresh conns
			if t, ok := s.client.Transport.(*http.Transport); ok {
				t.CloseIdleConnections()
			}
			if attempt < 2 && isRetriableConnectionError(err) {
				backoff := time.Duration(attempt+1) * 500 * time.Millisecond
				s.logf(slog.LevelInfo, "clickhouse connection error, retrying with fresh connection", "err", err, "attempt", attempt+1, "backoff_ms", backoff.Milliseconds())
				time.Sleep(backoff)
				continue
			}
			s.logf(slog.LevelError, "failed to write to clickhouse", "err", err)
			return
		}
		break
	}
	if resp == nil {
		return
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyStr := strings.TrimSpace(string(respBody))
		if !skipReinit && isSchemaMissing(bodyStr) {
			s.logf(slog.LevelInfo, "clickhouse database missing, reinitializing schema (e.g. tmpfs was wiped)", "body", bodyStr)
			if err := s.ensureSchema(s.database, s.table, s.retentionHours); err != nil {
				s.logf(slog.LevelError, "clickhouse schema reinit failed", "err", err)
				return
			}
			_ = s.setTTL()
			s.flushInternal(batch, true) // retry insert, skip reinit to avoid infinite loop
			return
		}
		s.logf(slog.LevelError, "clickhouse insert failed", "status", resp.StatusCode, "body", bodyStr)
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

func (s *ClickHouseStore) ensureSchema(database, table string, retentionHours int) error {
	if retentionHours <= 0 {
		retentionHours = 24 * 7 // 7 days default
	}
	createDB := fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s", database)
	if err := s.execQuery(createDB); err != nil {
		return fmt.Errorf("create database: %w", err)
	}
	// Migrate existing tables with daily partitions (partition ID 8 chars: YYYYMMDD) to hourly (10 chars: YYYYMMDDHH)
	if err := s.migrateToHourlyPartitionsIfNeeded(database, table); err != nil {
		return fmt.Errorf("migrate to hourly partitions: %w", err)
	}
	// Hourly partitions enable sub-day retention; TTL drops partitions older than retentionHours
	createTable := fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s.%s
(
    ts DateTime,
    client_ip String,
    client_name String DEFAULT '',
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
PARTITION BY toStartOfHour(ts)
ORDER BY (ts, qname)
TTL toStartOfHour(ts) + INTERVAL %d HOUR`, database, table, retentionHours)
	if err := s.execQuery(createTable); err != nil {
		return fmt.Errorf("create table: %w", err)
	}
	// Add client_name column to existing tables (no-op if already present)
	alterAddClientName := fmt.Sprintf("ALTER TABLE %s.%s ADD COLUMN IF NOT EXISTS client_name String DEFAULT ''", database, table)
	if err := s.execQuery(alterAddClientName); err != nil {
		s.logf(slog.LevelWarn, "failed to add client_name column (may already exist)", "err", err)
	}
	return nil
}

// migrateToHourlyPartitionsIfNeeded drops tables with daily partitions (YYYYMMDD) so they are recreated with hourly partitions.
// Hourly partitions (YYYYMMDDHH) enable sub-day retention. Data is lost; acceptable for tmpfs deployments.
func (s *ClickHouseStore) migrateToHourlyPartitionsIfNeeded(database, table string) error {
	query := fmt.Sprintf("SELECT partition FROM system.parts WHERE database = '%s' AND table = '%s' AND active LIMIT 1 FORMAT TabSeparated",
		strings.ReplaceAll(database, "'", "''"),
		strings.ReplaceAll(table, "'", "''"))
	endpoint, err := s.buildURL(query)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
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
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil // Table may not exist yet; proceed with create
	}
	partition := strings.TrimSpace(string(body))
	if partition == "" || partition == "\\N" {
		return nil // No parts yet
	}
	// Daily partition ID is 8 chars (YYYYMMDD); hourly is 10 (YYYYMMDDHH) or more
	if len(partition) == 8 && partition >= "20000101" {
		dropQuery := fmt.Sprintf("DROP TABLE IF EXISTS %s.%s", database, table)
		if err := s.execQuery(dropQuery); err != nil {
			return fmt.Errorf("drop old table: %w", err)
		}
		s.logf(slog.LevelInfo, "migrated query store to hourly partitions", "reason", "daily_partitions_detected")
	}
	return nil
}

func (s *ClickHouseStore) enforceMaxSize() {
	maxBytes := int64(s.maxSizeMB) * 1024 * 1024
	size, err := s.getTableSizeBytes()
	if err != nil {
		s.logf(slog.LevelWarn, "failed to get table size for max_size enforcement", "err", err)
		return
	}
	s.logf(slog.LevelDebug, "checked max query store size", "size_mb", size/(1024*1024), "max_mb", s.maxSizeMB)
	for size > maxBytes {
		partition, err := s.getOldestPartition()
		if err != nil || partition == "" {
			s.logf(slog.LevelWarn, "max_size exceeded but no partition to drop", "size_mb", size/(1024*1024), "max_mb", s.maxSizeMB, "err", err)
			return
		}
		// Validate partition format (YYYYMMDD or YYYYMMDDHH) to prevent SQL injection from crafted ClickHouse response
		if !isValidPartitionID(partition) {
			s.logf(slog.LevelWarn, "ignoring invalid partition ID from ClickHouse", "partition", partition)
			return
		}
		// Drop oldest partition to free space; must drop to prevent ClickHouse from running out of space
		dropQuery := fmt.Sprintf("ALTER TABLE %s.%s DROP PARTITION '%s'", s.database, s.table, partition)
		if err := s.execQuery(dropQuery); err != nil {
			s.logf(slog.LevelError, "failed to drop partition for max_size", "partition", partition, "err", err)
			return
		}
		s.logf(slog.LevelWarn, "max_size exceeded, dropped oldest partition", "partition", partition, "size_mb", size/(1024*1024), "max_mb", s.maxSizeMB)
		size, err = s.getTableSizeBytes()
		if err != nil {
			return
		}
	}
}

// getTableSizeBytes returns the on-disk size of our table including active and inactive
// parts. Inactive parts (e.g. replaced by merges) still consume tmpfs until cleanup.
// Note: total tmpfs usage is higher—ClickHouse has ~130–200MB overhead (metadata,
// WAL, merge buffers). Use tmpfs_size − 200 as max_size_mb to leave headroom.
func (s *ClickHouseStore) getTableSizeBytes() (int64, error) {
	// Include both active and inactive parts; inactive parts still use disk until removed
	query := fmt.Sprintf("SELECT coalesce(sum(bytes_on_disk), 0) FROM system.parts WHERE database = '%s' AND table = '%s' FORMAT TabSeparated",
		strings.ReplaceAll(s.database, "'", "''"),
		strings.ReplaceAll(s.table, "'", "''"))
	endpoint, err := s.buildURL(query)
	if err != nil {
		return 0, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, fmt.Errorf("status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	line := strings.TrimSpace(string(body))
	if line == "" || line == "\\N" {
		return 0, nil
	}
	var total int64
	if _, err := fmt.Sscanf(line, "%d", &total); err != nil {
		return 0, fmt.Errorf("parse size %q: %w", line, err)
	}
	return total, nil
}

func (s *ClickHouseStore) getOldestPartition() (string, error) {
	query := fmt.Sprintf("SELECT partition FROM system.parts WHERE database = '%s' AND table = '%s' AND active GROUP BY partition ORDER BY partition ASC LIMIT 1 FORMAT TabSeparated",
		strings.ReplaceAll(s.database, "'", "''"),
		strings.ReplaceAll(s.table, "'", "''"))
	endpoint, err := s.buildURL(query)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	partition := strings.TrimSpace(string(body))
	// Handle empty or newline-only response
	if partition == "" || partition == "\\N" {
		return "", nil
	}
	return partition, nil
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
	query := fmt.Sprintf("ALTER TABLE %s.%s MODIFY TTL toStartOfHour(ts) + INTERVAL %d HOUR", s.database, s.table, s.retentionHours)
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
	s.logf(slog.LevelInfo, "set query retention", "hours", s.retentionHours)
	return nil
}

func (s *ClickHouseStore) buildURL(query string) (string, error) {
	return s.buildURLWithParams(query, nil)
}

// buildInsertURL builds a URL for INSERT with async_insert params to batch writes and reduce disk I/O.
// async_insert_busy_timeout_ms is set from flushToDiskInterval so ClickHouse flushes to disk at most that often.
func (s *ClickHouseStore) buildInsertURL(query string) (string, error) {
	timeoutMs := int(s.flushToDiskInterval.Milliseconds())
	if timeoutMs < 1000 {
		timeoutMs = 1000 // minimum 1s to avoid excessive flushes
	}
	params := map[string]string{
		"async_insert":                 "1",
		"wait_for_async_insert":        "0",
		"async_insert_busy_timeout_ms": fmt.Sprintf("%d", timeoutMs),
	}
	return s.buildURLWithParams(query, params)
}

func (s *ClickHouseStore) buildURLWithParams(query string, extra map[string]string) (string, error) {
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
	for k, v := range extra {
		values.Set(k, v)
	}
	parsed.RawQuery = values.Encode()
	return parsed.String(), nil
}

func (s *ClickHouseStore) logf(level slog.Level, msg string, args ...any) {
	if s.logger == nil {
		return
	}
	s.logger.Log(nil, level, msg, args...)
}
