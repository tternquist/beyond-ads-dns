package cache

import (
	"context"
	"fmt"
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
	expiryIndexKey    = "dns:expiry:index"
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

func (c *RedisCache) SetWithIndex(ctx context.Context, key string, msg *dns.Msg, ttl time.Duration) error {
	if c == nil || msg == nil || ttl <= 0 {
		return nil
	}
	packed, err := msg.Pack()
	if err != nil {
		return err
	}
	expiry := time.Now().Add(ttl).Unix()
	pipe := c.client.TxPipeline()
	pipe.Set(ctx, key, packed, ttl)
	pipe.ZAdd(ctx, expiryIndexKey, redis.Z{Score: float64(expiry), Member: key})
	_, err = pipe.Exec(ctx)
	return err
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

func (c *RedisCache) GetHitCount(ctx context.Context, key string) (int64, error) {
	if c == nil {
		return 0, nil
	}
	count, err := c.client.Get(ctx, hitPrefix+key).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	if err != nil {
		return 0, err
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

func (c *RedisCache) ExpiryCandidates(ctx context.Context, until time.Time, limit int) ([]string, error) {
	if c == nil {
		return nil, nil
	}
	if limit <= 0 {
		return nil, nil
	}
	max := fmt.Sprintf("%d", until.Unix())
	return c.client.ZRangeByScore(ctx, expiryIndexKey, &redis.ZRangeBy{
		Min:    "-inf",
		Max:    max,
		Offset: 0,
		Count:  int64(limit),
	}).Result()
}

func (c *RedisCache) RemoveFromIndex(ctx context.Context, key string) {
	if c == nil {
		return
	}
	_, _ = c.client.ZRem(ctx, expiryIndexKey, key).Result()
}

func (c *RedisCache) TTL(ctx context.Context, key string) (time.Duration, error) {
	if c == nil {
		return 0, nil
	}
	ttl, err := c.client.TTL(ctx, key).Result()
	if err != nil {
		return 0, err
	}
	return ttl, nil
}

func (c *RedisCache) Close() error {
	if c == nil {
		return nil
	}
	return c.client.Close()
}
