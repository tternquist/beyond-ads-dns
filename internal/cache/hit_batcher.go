package cache

import (
	"context"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	hitBatchFlushInterval = 50 * time.Millisecond
	hitBatchMaxSize      = 100
)

// hitBatchEntry holds pending increments for a key and channels to deliver results.
type hitBatchEntry struct {
	delta   int64
	window  time.Duration
	futures []chan int64
}

// sweepBatchEntry holds pending sweep hit increments (no result needed).
type sweepBatchEntry struct {
	delta  int64
	window time.Duration
}

// hitBatcher batches IncrementHit and IncrementSweepHit calls to reduce Redis round-trips.
type hitBatcher struct {
	client redis.UniversalClient

	mu           sync.Mutex
	hitPending   map[string]*hitBatchEntry
	sweepPending map[string]*sweepBatchEntry

	flushInterval time.Duration
	maxBatchSize int

	stopCh chan struct{}
	doneCh chan struct{}
}

func newHitBatcher(client redis.UniversalClient) *hitBatcher {
	b := &hitBatcher{
		client:        client,
		hitPending:    make(map[string]*hitBatchEntry),
		sweepPending:  make(map[string]*sweepBatchEntry),
		flushInterval: hitBatchFlushInterval,
		maxBatchSize:  hitBatchMaxSize,
		stopCh:        make(chan struct{}),
		doneCh:        make(chan struct{}),
	}
	go b.run()
	return b
}

func (b *hitBatcher) run() {
	defer close(b.doneCh)
	ticker := time.NewTicker(b.flushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-b.stopCh:
			b.flushAll()
			return
		case <-ticker.C:
			b.maybeFlush()
		}
	}
}

func (b *hitBatcher) stop() {
	close(b.stopCh)
	<-b.doneCh
}

// addHit adds a hit increment and returns a channel that receives the new count when flushed.
// The caller should wait on the channel with context. If ctx is done before flush, the channel
// may never receive (caller should handle timeout).
func (b *hitBatcher) addHit(redisKey string, window time.Duration) chan int64 {
	future := make(chan int64, 1)
	b.mu.Lock()
	entry, ok := b.hitPending[redisKey]
	if !ok {
		entry = &hitBatchEntry{delta: 0, window: window}
		b.hitPending[redisKey] = entry
	}
	entry.delta++
	entry.futures = append(entry.futures, future)
	shouldFlush := len(b.hitPending) >= b.maxBatchSize
	b.mu.Unlock()
	if shouldFlush {
		b.maybeFlush()
	}
	return future
}

// addSweepHit adds a sweep hit increment (fire-and-forget).
func (b *hitBatcher) addSweepHit(redisKey string, window time.Duration) {
	b.mu.Lock()
	entry, ok := b.sweepPending[redisKey]
	if !ok {
		entry = &sweepBatchEntry{window: window}
		b.sweepPending[redisKey] = entry
	}
	entry.delta++
	shouldFlush := len(b.sweepPending) >= b.maxBatchSize
	b.mu.Unlock()
	if shouldFlush {
		b.maybeFlush()
	}
}

func (b *hitBatcher) maybeFlush() {
	b.mu.Lock()
	hitSnapshot := b.hitPending
	sweepSnapshot := b.sweepPending
	if len(hitSnapshot) == 0 && len(sweepSnapshot) == 0 {
		b.mu.Unlock()
		return
	}
	b.hitPending = make(map[string]*hitBatchEntry)
	b.sweepPending = make(map[string]*sweepBatchEntry)
	b.mu.Unlock()

	b.flushHits(hitSnapshot)
	b.flushSweepHits(sweepSnapshot)
}

func (b *hitBatcher) flushAll() {
	b.mu.Lock()
	hitSnapshot := b.hitPending
	sweepSnapshot := b.sweepPending
	b.hitPending = make(map[string]*hitBatchEntry)
	b.sweepPending = make(map[string]*sweepBatchEntry)
	b.mu.Unlock()

	b.flushHits(hitSnapshot)
	b.flushSweepHits(sweepSnapshot)
}

func (b *hitBatcher) flushHits(entries map[string]*hitBatchEntry) {
	if len(entries) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	pipe := b.client.Pipeline()
	type kv struct {
		key   string
		entry *hitBatchEntry
	}
	ordered := make([]kv, 0, len(entries))
	cmds := make([]*redis.IntCmd, 0, len(entries))
	for key, entry := range entries {
		cmd := pipe.IncrBy(ctx, key, entry.delta)
		cmds = append(cmds, cmd)
		ordered = append(ordered, kv{key, entry})
		if entry.window > 0 {
			pipe.Expire(ctx, key, entry.window)
		}
	}
	_, err := pipe.Exec(ctx)
	if err != nil {
		for _, item := range ordered {
			for _, ch := range item.entry.futures {
				close(ch)
			}
		}
		return
	}
	for i, item := range ordered {
		count := int64(0)
		if i < len(cmds) {
			count, _ = cmds[i].Result()
		}
		for _, ch := range item.entry.futures {
			select {
			case ch <- count:
			default:
			}
			close(ch)
		}
	}
}

func (b *hitBatcher) flushSweepHits(entries map[string]*sweepBatchEntry) {
	if len(entries) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	pipe := b.client.Pipeline()
	for key, entry := range entries {
		pipe.IncrBy(ctx, key, entry.delta)
		if entry.window > 0 {
			pipe.Expire(ctx, key, entry.window)
		}
	}
	_, _ = pipe.Exec(ctx)
}
