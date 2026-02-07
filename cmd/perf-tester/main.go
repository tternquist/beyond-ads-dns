package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/miekg/dns"
	"github.com/redis/go-redis/v9"
)

type options struct {
	resolver       string
	protocol       string
	namesPath      string
	generateCount  int
	writeNamesPath string
	queries        int
	concurrency    int
	timeout        time.Duration
	qtype          string
	shuffle        bool
	seed           int64
	warmup         int
	flushRedis     bool
	redisAddr      string
	redisDB        int
	redisPassword  string
}

type runStats struct {
	total     int64
	errors    int64
	latencies []int64
	rcodes    map[int]int64
	mu        sync.Mutex
	index     uint64
}

func main() {
	opts := parseFlags()
	logger := log.New(os.Stdout, "perf-tester ", log.LstdFlags)

	if opts.flushRedis {
		if err := flushRedis(opts, logger); err != nil {
			logger.Fatalf("failed to flush redis: %v", err)
		}
	}

	names, err := loadNames(opts)
	if err != nil {
		logger.Fatalf("failed to load names: %v", err)
	}
	if len(names) == 0 {
		logger.Fatalf("no DNS names loaded")
	}

	if opts.shuffle {
		shuffle(names, opts.seed)
	}

	if opts.warmup > 0 {
		logger.Printf("warmup: %d queries", opts.warmup)
		runBenchmark(names, opts, opts.warmup, false, logger)
	}

	logger.Printf("starting benchmark: %d queries, %d concurrency", opts.queries, opts.concurrency)
	start := time.Now()
	stats := runBenchmark(names, opts, opts.queries, true, logger)
	elapsed := time.Since(start)

	printSummary(stats, elapsed, logger)
}

func parseFlags() options {
	opts := options{}
	flag.StringVar(&opts.resolver, "resolver", "127.0.0.1:53", "DNS resolver address host:port")
	flag.StringVar(&opts.protocol, "protocol", "udp", "Protocol: udp or tcp")
	flag.StringVar(&opts.namesPath, "names", "", "Path to newline-delimited DNS names file")
	flag.IntVar(&opts.generateCount, "generate", 10000, "Number of synthetic names to generate if no file")
	flag.StringVar(&opts.writeNamesPath, "write-names", "", "Write generated names to a file")
	flag.IntVar(&opts.queries, "queries", 10000, "Number of queries to send")
	flag.IntVar(&opts.concurrency, "concurrency", 50, "Number of concurrent workers")
	flag.DurationVar(&opts.timeout, "timeout", 2*time.Second, "DNS query timeout")
	flag.StringVar(&opts.qtype, "qtype", "A", "DNS query type (A, AAAA, TXT, etc)")
	flag.BoolVar(&opts.shuffle, "shuffle", true, "Shuffle names before running")
	flag.Int64Var(&opts.seed, "seed", time.Now().UnixNano(), "Random seed for shuffling")
	flag.IntVar(&opts.warmup, "warmup", 0, "Warmup queries (not recorded)")
	flag.BoolVar(&opts.flushRedis, "flush-redis", false, "Flush Redis before running")
	flag.StringVar(&opts.redisAddr, "redis-addr", "localhost:6379", "Redis address host:port")
	flag.IntVar(&opts.redisDB, "redis-db", 0, "Redis DB number")
	flag.StringVar(&opts.redisPassword, "redis-password", "", "Redis password")
	flag.Parse()

	if opts.concurrency <= 0 {
		opts.concurrency = 1
	}
	if opts.queries <= 0 {
		opts.queries = 1
	}
	opts.protocol = strings.ToLower(strings.TrimSpace(opts.protocol))
	return opts
}

func loadNames(opts options) ([]string, error) {
	if opts.namesPath != "" {
		return readNamesFile(opts.namesPath)
	}
	names := generateNames(opts.generateCount)
	if opts.writeNamesPath != "" {
		if err := writeNamesFile(opts.writeNamesPath, names); err != nil {
			return nil, err
		}
	}
	return names, nil
}

func readNamesFile(path string) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var names []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		names = append(names, line)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return names, nil
}

func writeNamesFile(path string, names []string) error {
	if err := os.MkdirAll(filepathDir(path), 0o755); err != nil {
		return err
	}
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()
	writer := bufio.NewWriter(file)
	for _, name := range names {
		if _, err := writer.WriteString(name + "\n"); err != nil {
			return err
		}
	}
	return writer.Flush()
}

func filepathDir(path string) string {
	if idx := strings.LastIndex(path, "/"); idx != -1 {
		return path[:idx]
	}
	return "."
}

func generateNames(count int) []string {
	if count <= 0 {
		return nil
	}
	prefixes := []string{
		"ads", "trk", "pixel", "beacon", "metrics", "cdn", "img", "static",
		"media", "video", "api", "edge", "promo", "offer", "sponsor", "bid",
		"ssp", "dsp", "analytics", "telemetry",
	}
	roots := []string{
		"example", "sample", "demo", "test", "adsnet", "track",
		"content", "mediahub", "stream", "cloud", "edgecast", "metrics",
		"insights", "pixel", "promo", "offer", "ads", "stats",
	}
	tlds := []string{"com", "net", "org", "io", "co", "dev", "app", "site"}

	names := make([]string, 0, count)
	for i := 0; len(names) < count; i++ {
		prefix := prefixes[i%len(prefixes)]
		root := roots[(i/len(prefixes))%len(roots)]
		tld := tlds[(i/(len(prefixes)*len(roots)))%len(tlds)]
		label := fmt.Sprintf("%s-%d", prefix, i)
		names = append(names, fmt.Sprintf("%s.%s.%s", label, root, tld))
	}
	return names
}

func shuffle(names []string, seed int64) {
	rng := rand.New(rand.NewSource(seed))
	rng.Shuffle(len(names), func(i, j int) {
		names[i], names[j] = names[j], names[i]
	})
}

func runBenchmark(names []string, opts options, total int, record bool, logger *log.Logger) runStats {
	stats := runStats{
		total:     int64(total),
		latencies: make([]int64, total),
		rcodes:    make(map[int]int64),
	}

	jobs := make(chan string, opts.concurrency)
	var wg sync.WaitGroup
	for i := 0; i < opts.concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			client := &dns.Client{
				Net:     opts.protocol,
				Timeout: opts.timeout,
			}
			qtype, ok := dns.StringToType[strings.ToUpper(opts.qtype)]
			if !ok {
				qtype = dns.TypeA
			}
			for name := range jobs {
				start := time.Now()
				msg := new(dns.Msg)
				msg.SetQuestion(dns.Fqdn(name), qtype)
				resp, _, err := client.Exchange(msg, opts.resolver)
				duration := time.Since(start)

				if record {
					index := atomic.AddUint64(&stats.index, 1) - 1
					if int(index) < len(stats.latencies) {
						stats.latencies[index] = duration.Microseconds()
					}
				}

				if err != nil {
					atomic.AddInt64(&stats.errors, 1)
					continue
				}
				if resp != nil && record {
					stats.mu.Lock()
					stats.rcodes[resp.Rcode]++
					stats.mu.Unlock()
				}
			}
		}()
	}

	for i := 0; i < total; i++ {
		jobs <- names[i%len(names)]
	}
	close(jobs)
	wg.Wait()

	if record {
		logger.Printf("completed %d queries with %d errors", total, stats.errors)
	}
	return stats
}

func printSummary(stats runStats, elapsed time.Duration, logger *log.Logger) {
	latencies := stats.latencies[:stats.index]
	if len(latencies) == 0 {
		logger.Printf("no latency samples recorded")
		return
	}
	sorted := make([]int64, len(latencies))
	copy(sorted, latencies)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })

	avg := average(sorted)
	p50 := percentile(sorted, 50)
	p95 := percentile(sorted, 95)
	p99 := percentile(sorted, 99)
	min := sorted[0]
	max := sorted[len(sorted)-1]
	qps := float64(stats.total) / elapsed.Seconds()

	logger.Printf("elapsed: %s", elapsed.Round(time.Millisecond))
	logger.Printf("qps: %.2f", qps)
	logger.Printf("latency (ms): avg=%.3f p50=%.3f p95=%.3f p99=%.3f min=%.3f max=%.3f",
		toMillis(avg), toMillis(p50), toMillis(p95), toMillis(p99), toMillis(min), toMillis(max))

	stats.mu.Lock()
	if len(stats.rcodes) > 0 {
		logger.Printf("rcode counts:")
		for _, code := range sortedKeys(stats.rcodes) {
			logger.Printf("  %s (%d): %d", dns.RcodeToString[code], code, stats.rcodes[code])
		}
	}
	stats.mu.Unlock()
	logger.Printf("errors: %d", stats.errors)
}

func average(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}
	var sum int64
	for _, v := range values {
		sum += v
	}
	return sum / int64(len(values))
}

func percentile(values []int64, percentile int) int64 {
	if len(values) == 0 {
		return 0
	}
	if percentile <= 0 {
		return values[0]
	}
	if percentile >= 100 {
		return values[len(values)-1]
	}
	rank := (float64(percentile) / 100) * float64(len(values)-1)
	index := int(rank + 0.5)
	if index < 0 {
		index = 0
	}
	if index >= len(values) {
		index = len(values) - 1
	}
	return values[index]
}

func toMillis(value int64) float64 {
	return float64(value) / 1000
}

func sortedKeys(rcodes map[int]int64) []int {
	keys := make([]int, 0, len(rcodes))
	for code := range rcodes {
		keys = append(keys, code)
	}
	sort.Ints(keys)
	return keys
}

func flushRedis(opts options, logger *log.Logger) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client := redis.NewClient(&redis.Options{
		Addr:     opts.redisAddr,
		DB:       opts.redisDB,
		Password: opts.redisPassword,
	})
	defer func() {
		_ = client.Close()
	}()
	if err := client.Ping(ctx).Err(); err != nil {
		return err
	}
	logger.Printf("flushing redis %s db=%d", opts.redisAddr, opts.redisDB)
	return client.FlushDB(ctx).Err()
}
