package querystore

import "time"

type Event struct {
	Timestamp       time.Time
	ClientIP        string
	Protocol        string
	QName           string
	QType           string
	QClass          string
	Outcome         string
	RCode           string
	DurationMS      float64
	CacheLookupMS   float64
	NetworkWriteMS  float64
}

type Store interface {
	Record(event Event)
	Close() error
	Stats() StoreStats
}

type StoreStats struct {
	BufferSize    int    `json:"buffer_size"`
	BufferUsed    int    `json:"buffer_used"`
	DroppedEvents uint64 `json:"dropped_events"`
	TotalRecorded uint64 `json:"total_recorded"`
}
