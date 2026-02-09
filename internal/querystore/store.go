package querystore

import "time"

type Event struct {
	Timestamp  time.Time
	ClientIP   string
	Protocol   string
	QName      string
	QType      string
	QClass     string
	Outcome    string
	RCode      string
	DurationMS float64
}

type Store interface {
	Record(event Event)
	Close() error
}
