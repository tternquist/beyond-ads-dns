package cache

import (
	"container/list"
	"sync"
	"time"

	"github.com/miekg/dns"
)

// LRUCache is a thread-safe in-memory LRU cache for DNS responses
type LRUCache struct {
	maxEntries int
	mu         sync.RWMutex
	ll         *list.List
	cache      map[string]*list.Element
}

type lruEntry struct {
	key        string
	msg        *dns.Msg
	expiry     time.Time
	softExpiry time.Time
}

// NewLRUCache creates a new LRU cache with the specified maximum number of entries
func NewLRUCache(maxEntries int) *LRUCache {
	if maxEntries <= 0 {
		maxEntries = 1000
	}
	return &LRUCache{
		maxEntries: maxEntries,
		ll:         list.New(),
		cache:      make(map[string]*list.Element),
	}
}

// Get retrieves a DNS message from the cache
// Returns the message and remaining TTL (0 if expired or not found)
func (c *LRUCache) Get(key string) (*dns.Msg, time.Duration, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	elem, ok := c.cache[key]
	if !ok {
		return nil, 0, false
	}

	entry := elem.Value.(*lruEntry)
	now := time.Now()

	// Check if entry has expired
	if now.After(entry.expiry) {
		c.removeElement(elem)
		return nil, 0, false
	}

	// Move to front (most recently used)
	c.ll.MoveToFront(elem)

	// Calculate remaining TTL based on soft expiry
	remaining := entry.softExpiry.Sub(now)
	if remaining < 0 {
		remaining = 0
	}

	// Return a copy of the message to avoid mutations
	return entry.msg.Copy(), remaining, true
}

// Set adds or updates a DNS message in the cache
func (c *LRUCache) Set(key string, msg *dns.Msg, ttl time.Duration) {
	if msg == nil || ttl <= 0 {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	softExpiry := now.Add(ttl)
	// Hard expiry with a grace period (2x TTL or max 1 hour)
	gracePeriod := ttl
	if gracePeriod > time.Hour {
		gracePeriod = time.Hour
	}
	expiry := softExpiry.Add(gracePeriod)

	// If key exists, update it
	if elem, ok := c.cache[key]; ok {
		entry := elem.Value.(*lruEntry)
		entry.msg = msg.Copy()
		entry.expiry = expiry
		entry.softExpiry = softExpiry
		c.ll.MoveToFront(elem)
		return
	}

	// Add new entry
	entry := &lruEntry{
		key:        key,
		msg:        msg.Copy(),
		expiry:     expiry,
		softExpiry: softExpiry,
	}
	elem := c.ll.PushFront(entry)
	c.cache[key] = elem

	// Evict oldest entry if cache is full
	if c.ll.Len() > c.maxEntries {
		oldest := c.ll.Back()
		if oldest != nil {
			c.removeElement(oldest)
		}
	}
}

// Delete removes a key from the cache
func (c *LRUCache) Delete(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.cache[key]; ok {
		c.removeElement(elem)
	}
}

// Clear removes all entries from the cache
func (c *LRUCache) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.ll.Init()
	c.cache = make(map[string]*list.Element)
}

// Len returns the current number of entries in the cache
func (c *LRUCache) Len() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.ll.Len()
}

// Stats returns cache statistics
func (c *LRUCache) Stats() LRUStats {
	c.mu.RLock()
	defer c.mu.RUnlock()

	now := time.Now()
	fresh := 0
	stale := 0
	expired := 0

	for e := c.ll.Front(); e != nil; e = e.Next() {
		entry := e.Value.(*lruEntry)
		if now.After(entry.expiry) {
			expired++
		} else if now.After(entry.softExpiry) {
			stale++
		} else {
			fresh++
		}
	}

	return LRUStats{
		Entries:    c.ll.Len(),
		MaxEntries: c.maxEntries,
		Fresh:      fresh,
		Stale:      stale,
		Expired:    expired,
	}
}

// LRUStats contains statistics about the LRU cache
type LRUStats struct {
	Entries    int `json:"entries"`
	MaxEntries int `json:"max_entries"`
	Fresh      int `json:"fresh"`
	Stale      int `json:"stale"`
	Expired    int `json:"expired"`
}

// removeElement removes an element from the cache
// Must be called with c.mu held
func (c *LRUCache) removeElement(elem *list.Element) {
	c.ll.Remove(elem)
	entry := elem.Value.(*lruEntry)
	delete(c.cache, entry.key)
}

// CleanExpired removes all expired entries from the cache
// Returns the number of entries removed
func (c *LRUCache) CleanExpired() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	removed := 0
	var next *list.Element

	for e := c.ll.Front(); e != nil; e = next {
		next = e.Next()
		entry := e.Value.(*lruEntry)
		if now.After(entry.expiry) {
			c.removeElement(e)
			removed++
		}
	}

	return removed
}
