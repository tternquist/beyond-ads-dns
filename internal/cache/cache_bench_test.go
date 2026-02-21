package cache

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/miekg/dns"
	"github.com/tternquist/beyond-ads-dns/internal/config"
)

func BenchmarkShardedLRUCacheGet(b *testing.B) {
	cache := NewShardedLRUCache(10000, nil, 0)
	key := "test.example.com:1:1"
	msg := new(dns.Msg)
	msg.SetQuestion("test.example.com.", dns.TypeA)
	msg.Response = true
	msg.Answer = append(msg.Answer, &dns.A{
		Hdr: dns.RR_Header{Name: "test.example.com.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
		A:   []byte{1, 2, 3, 4},
	})
	cache.Set(key, msg, 60*time.Second)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, _ = cache.Get(key)
	}
}

func BenchmarkRedisCacheGetCacheStats(b *testing.B) {
	mr, err := miniredis.Run()
	if err != nil {
		b.Fatalf("miniredis: %v", err)
	}
	defer mr.Close()

	cfg := config.RedisConfig{
		Mode:    "standalone",
		Address: mr.Addr(),
	}
	c, err := NewRedisCache(cfg, nil)
	if err != nil {
		b.Fatalf("NewRedisCache: %v", err)
	}
	defer c.Close()

	// Pre-populate keys so countKeysByPrefix has work (cached 30s in GetCacheStats)
	ctx := context.Background()
	for i := 0; i < 100; i++ {
		key := fmt.Sprintf("dns:bench-key-%d.example.com.:1:1", i)
		msg := new(dns.Msg)
		msg.SetQuestion("test.example.com.", dns.TypeA)
		msg.Response = true
		_ = c.Set(ctx, key, msg, 60*time.Second)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = c.GetCacheStats()
	}
}

func BenchmarkLRUCacheGet(b *testing.B) {
	c := NewLRUCache(10000, nil, time.Hour)
	key := "test.example.com:1:1"
	msg := new(dns.Msg)
	msg.SetQuestion("test.example.com.", dns.TypeA)
	msg.Response = true
	c.Set(key, msg, 60*time.Second)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, _ = c.Get(key)
	}
}

// BenchmarkShardedLRUCacheGetParallel measures Get throughput with concurrent readers.
// SIEVE uses RLock on hit path, so parallel reads scale better than LRU's exclusive Lock.
func BenchmarkShardedLRUCacheGetParallel(b *testing.B) {
	cache := NewShardedLRUCache(10000, nil, 0)
	key := "test.example.com:1:1"
	msg := new(dns.Msg)
	msg.SetQuestion("test.example.com.", dns.TypeA)
	msg.Response = true
	cache.Set(key, msg, 60*time.Second)

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			_, _, _ = cache.Get(key)
		}
	})
}
