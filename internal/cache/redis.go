package cache

import (
	"context"
	"strings"
	"time"

	"github.com/miekg/dns"
	"github.com/redis/go-redis/v9"
	"github.com/tternquist/beyond-ads-dns/internal/config"
)

type RedisCache struct {
	client *redis.Client
}

const (
	refreshLockPrefix = "dns:refresh:"
	hitPrefix         = "dns:hit:"
)

func NewRedisCache(cfg config.RedisConfig) (*RedisCache, error) {
	if strings.TrimSpace(cfg.Address) == "" {
		return nil, nil
	}
	client := redis.NewClient(&redis.Options{
		Addr:     cfg.Address,
		DB:       cfg.DB,
		Password: cfg.Password,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		return nil, err
	}
	return &RedisCache{client: client}, nil
}

func (c *RedisCache) Get(ctx context.Context, key string) (*dns.Msg, error) {
	if c == nil {
		return nil, nil
	}
	data, err := c.client.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	msg := new(dns.Msg)
	if err := msg.Unpack(data); err != nil {
		return nil, err
	}
	return msg, nil
}

func (c *RedisCache) GetWithTTL(ctx context.Context, key string) (*dns.Msg, time.Duration, error) {
	if c == nil {
		return nil, 0, nil
	}
	pipe := c.client.Pipeline()
	getCmd := pipe.Get(ctx, key)
	ttlCmd := pipe.TTL(ctx, key)
	_, _ = pipe.Exec(ctx)

	if err := getCmd.Err(); err != nil {
		if err == redis.Nil {
			return nil, 0, nil
		}
		return nil, 0, err
	}

	data, err := getCmd.Bytes()
	if err != nil {
		return nil, 0, err
	}
	msg := new(dns.Msg)
	if err := msg.Unpack(data); err != nil {
		return nil, 0, err
	}

	ttl := ttlCmd.Val()
	if ttlCmd.Err() != nil || ttl < 0 {
		ttl = 0
	}
	return msg, ttl, nil
}

func (c *RedisCache) Set(ctx context.Context, key string, msg *dns.Msg, ttl time.Duration) error {
	if c == nil || msg == nil || ttl <= 0 {
		return nil
	}
	packed, err := msg.Pack()
	if err != nil {
		return err
	}
	return c.client.Set(ctx, key, packed, ttl).Err()
}

func (c *RedisCache) IncrementHit(ctx context.Context, key string, window time.Duration) (int64, error) {
	if c == nil {
		return 0, nil
	}
	hitKey := hitPrefix + key
	count, err := c.client.Incr(ctx, hitKey).Result()
	if err != nil {
		return 0, err
	}
	if count == 1 && window > 0 {
		_ = c.client.Expire(ctx, hitKey, window).Err()
	}
	return count, nil
}

func (c *RedisCache) TryAcquireRefresh(ctx context.Context, key string, ttl time.Duration) (bool, error) {
	if c == nil {
		return false, nil
	}
	if ttl <= 0 {
		ttl = 10 * time.Second
	}
	lockKey := refreshLockPrefix + key
	return c.client.SetNX(ctx, lockKey, "1", ttl).Result()
}

func (c *RedisCache) ReleaseRefresh(ctx context.Context, key string) {
	if c == nil {
		return
	}
	lockKey := refreshLockPrefix + key
	_, _ = c.client.Del(ctx, lockKey).Result()
}

func (c *RedisCache) Close() error {
	if c == nil {
		return nil
	}
	return c.client.Close()
}
