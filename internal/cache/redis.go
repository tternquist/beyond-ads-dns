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

func (c *RedisCache) Close() error {
	if c == nil {
		return nil
	}
	return c.client.Close()
}
