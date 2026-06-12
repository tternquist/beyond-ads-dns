package blocklist

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/tternquist/beyond-ads-dns/internal/config"
)

// sourceCache persists the last successfully fetched domain set per source URL
// so a failed refresh can fall back to it instead of dropping the source's
// domains. Files are keyed by a hash of the URL, so renamed sources keep their
// cache and multiple managers (global + per-group) referencing the same URL
// share one file. Writes go through a temp file + rename so concurrent
// managers never observe a partial file.
type sourceCache struct {
	dir string
}

func newSourceCache(cfg *config.BlocklistSourceCacheConfig) *sourceCache {
	if cfg == nil || cfg.Enabled == nil || !*cfg.Enabled || cfg.Directory == "" {
		return nil
	}
	return &sourceCache{dir: cfg.Directory}
}

func (c *sourceCache) path(url string) string {
	sum := sha256.Sum256([]byte(url))
	return filepath.Join(c.dir, hex.EncodeToString(sum[:8])+".txt")
}

// save writes the domain set for url. Returns the number of domains written.
func (c *sourceCache) save(url string, domains map[string]struct{}) error {
	if err := os.MkdirAll(c.dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(c.dir, ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	w := bufio.NewWriter(tmp)
	fmt.Fprintf(w, "# url: %s\n# saved_at: %d\n", url, time.Now().Unix())
	for domain := range domains {
		w.WriteString(domain)
		w.WriteByte('\n')
	}
	if err := w.Flush(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), c.path(url))
}

// load returns the cached domain set for url and when it was saved.
func (c *sourceCache) load(url string) (map[string]struct{}, time.Time, error) {
	f, err := os.Open(c.path(url))
	if err != nil {
		return nil, time.Time{}, err
	}
	defer f.Close()
	domains := make(map[string]struct{})
	var savedAt time.Time
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			if ts, ok := strings.CutPrefix(line, "# saved_at: "); ok {
				if sec, err := strconv.ParseInt(strings.TrimSpace(ts), 10, 64); err == nil {
					savedAt = time.Unix(sec, 0)
				}
			}
			continue
		}
		domains[line] = struct{}{}
	}
	if err := scanner.Err(); err != nil {
		return nil, time.Time{}, err
	}
	return domains, savedAt, nil
}
