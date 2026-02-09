package blocklist

import (
	"hash/fnv"
	"math"
	"sync"
)

// BloomFilter is a space-efficient probabilistic data structure for fast set membership tests
// It can definitively say an element is NOT in the set, or that it MIGHT be in the set
type BloomFilter struct {
	bits      []uint64
	size      uint64
	hashCount uint
	mu        sync.RWMutex
}

// NewBloomFilter creates a new bloom filter optimized for the expected number of elements
// with a target false positive rate
func NewBloomFilter(expectedElements int, falsePositiveRate float64) *BloomFilter {
	if expectedElements <= 0 {
		expectedElements = 1000000 // Default to 1 million
	}
	if falsePositiveRate <= 0 || falsePositiveRate >= 1 {
		falsePositiveRate = 0.01 // Default 1% false positive rate
	}

	// Calculate optimal size and hash count
	// m = -n * ln(p) / (ln(2)^2) where n = expected elements, p = false positive rate
	m := uint64(math.Ceil(-float64(expectedElements) * math.Log(falsePositiveRate) / (math.Log(2) * math.Log(2))))
	
	// k = m/n * ln(2) where k = number of hash functions
	k := uint(math.Ceil(float64(m) / float64(expectedElements) * math.Log(2)))
	
	// Ensure at least 2 hash functions
	if k < 2 {
		k = 2
	}
	
	// Size in uint64 words (each holds 64 bits)
	numWords := (m + 63) / 64
	
	return &BloomFilter{
		bits:      make([]uint64, numWords),
		size:      m,
		hashCount: k,
	}
}

// Add adds an element to the bloom filter
func (bf *BloomFilter) Add(element string) {
	bf.mu.Lock()
	defer bf.mu.Unlock()
	
	hashes := bf.hash(element)
	for _, h := range hashes {
		index := h % bf.size
		wordIndex := index / 64
		bitIndex := index % 64
		bf.bits[wordIndex] |= 1 << bitIndex
	}
}

// MayContain checks if an element might be in the set
// Returns false if definitely NOT in the set
// Returns true if MIGHT be in the set (need to check actual set)
func (bf *BloomFilter) MayContain(element string) bool {
	bf.mu.RLock()
	defer bf.mu.RUnlock()
	
	hashes := bf.hash(element)
	for _, h := range hashes {
		index := h % bf.size
		wordIndex := index / 64
		bitIndex := index % 64
		if (bf.bits[wordIndex] & (1 << bitIndex)) == 0 {
			return false // Definitely not in the set
		}
	}
	return true // Might be in the set
}

// Clear resets the bloom filter
func (bf *BloomFilter) Clear() {
	bf.mu.Lock()
	defer bf.mu.Unlock()
	
	for i := range bf.bits {
		bf.bits[i] = 0
	}
}

// Stats returns statistics about the bloom filter
func (bf *BloomFilter) Stats() BloomStats {
	bf.mu.RLock()
	defer bf.mu.RUnlock()
	
	setBits := 0
	for _, word := range bf.bits {
		// Count set bits using Brian Kernighan's algorithm
		for w := word; w != 0; w &= w - 1 {
			setBits++
		}
	}
	
	fillRatio := float64(setBits) / float64(bf.size)
	
	// Estimate number of elements: n ≈ -m/k * ln(1 - setBits/m)
	var estimatedElements int
	if fillRatio < 1.0 {
		estimatedElements = int(-float64(bf.size) / float64(bf.hashCount) * math.Log(1-fillRatio))
	}
	
	// Estimate current false positive rate: p ≈ (1 - e^(-kn/m))^k
	estimatedFPR := 0.0
	if estimatedElements > 0 {
		estimatedFPR = math.Pow(1-math.Exp(-float64(bf.hashCount)*float64(estimatedElements)/float64(bf.size)), float64(bf.hashCount))
	}
	
	return BloomStats{
		Size:              bf.size,
		HashCount:         bf.hashCount,
		SetBits:           setBits,
		FillRatio:         fillRatio,
		EstimatedElements: estimatedElements,
		EstimatedFPR:      estimatedFPR,
	}
}

// BloomStats contains statistics about the bloom filter
type BloomStats struct {
	Size              uint64  `json:"size"`
	HashCount         uint    `json:"hash_count"`
	SetBits           int     `json:"set_bits"`
	FillRatio         float64 `json:"fill_ratio"`
	EstimatedElements int     `json:"estimated_elements"`
	EstimatedFPR      float64 `json:"estimated_fpr"`
}

// hash generates k hash values for the given element using double hashing
// This uses the "double hashing" technique: h_i(x) = h1(x) + i*h2(x)
func (bf *BloomFilter) hash(element string) []uint64 {
	hashes := make([]uint64, bf.hashCount)
	
	// Use FNV-1a for primary hash
	h1 := fnv.New64a()
	h1.Write([]byte(element))
	hash1 := h1.Sum64()
	
	// Use FNV-1 for secondary hash
	h2 := fnv.New64()
	h2.Write([]byte(element))
	hash2 := h2.Sum64()
	
	// Generate k hashes using double hashing
	for i := uint(0); i < bf.hashCount; i++ {
		hashes[i] = hash1 + uint64(i)*hash2
	}
	
	return hashes
}
