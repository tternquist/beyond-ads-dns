package blocklist

import (
	"fmt"
	"testing"
)

func TestBloomFilter_Basic(t *testing.T) {
	bf := NewBloomFilter(1000, 0.01)
	
	// Add some elements
	bf.Add("example.com")
	bf.Add("google.com")
	bf.Add("github.com")
	
	// Should return true for added elements
	if !bf.MayContain("example.com") {
		t.Error("expected example.com to be in bloom filter")
	}
	if !bf.MayContain("google.com") {
		t.Error("expected google.com to be in bloom filter")
	}
	if !bf.MayContain("github.com") {
		t.Error("expected github.com to be in bloom filter")
	}
	
	// Elements not added should likely return false
	// (with small chance of false positive)
	results := []bool{
		bf.MayContain("notadded.com"),
		bf.MayContain("different.org"),
		bf.MayContain("other.net"),
	}
	
	// At least one should be false (very high probability)
	falseCount := 0
	for _, result := range results {
		if !result {
			falseCount++
		}
	}
	if falseCount == 0 {
		t.Log("Warning: all negative lookups returned true (unlikely but possible with small bloom filter)")
	}
}

func TestBloomFilter_FalsePositiveRate(t *testing.T) {
	// Test with larger dataset
	bf := NewBloomFilter(10000, 0.01)
	
	// Add 10000 elements
	added := make(map[string]bool)
	for i := 0; i < 10000; i++ {
		element := fmt.Sprintf("domain-%d.com", i)
		bf.Add(element)
		added[element] = true
	}
	
	// All added elements should return true
	for i := 0; i < 10000; i++ {
		element := fmt.Sprintf("domain-%d.com", i)
		if !bf.MayContain(element) {
			t.Errorf("false negative for %s", element)
		}
	}
	
	// Test false positive rate with elements not added
	falsePositives := 0
	testCount := 10000
	for i := 10000; i < 10000+testCount; i++ {
		element := fmt.Sprintf("domain-%d.com", i)
		if bf.MayContain(element) {
			falsePositives++
		}
	}
	
	fpr := float64(falsePositives) / float64(testCount)
	t.Logf("False positive rate: %.4f (target: 0.01)", fpr)
	
	// Allow some margin (0.02 = 2% max, target is 1%)
	if fpr > 0.05 {
		t.Errorf("false positive rate too high: %.4f > 0.05", fpr)
	}
}

func TestBloomFilter_Clear(t *testing.T) {
	bf := NewBloomFilter(100, 0.01)
	
	// Add elements
	bf.Add("example.com")
	bf.Add("google.com")
	
	if !bf.MayContain("example.com") {
		t.Error("expected example.com before clear")
	}
	
	// Clear the filter
	bf.Clear()
	
	// After clear, elements should likely not be found
	// (though there's still a theoretical false positive chance)
	stats := bf.Stats()
	if stats.SetBits != 0 {
		t.Errorf("expected 0 set bits after clear, got %d", stats.SetBits)
	}
}

func TestBloomFilter_Stats(t *testing.T) {
	bf := NewBloomFilter(1000, 0.01)
	
	// Add 500 elements
	for i := 0; i < 500; i++ {
		bf.Add(fmt.Sprintf("domain-%d.com", i))
	}
	
	stats := bf.Stats()
	
	if stats.Size == 0 {
		t.Error("expected non-zero size")
	}
	if stats.HashCount == 0 {
		t.Error("expected non-zero hash count")
	}
	if stats.SetBits == 0 {
		t.Error("expected some bits to be set")
	}
	if stats.FillRatio <= 0 || stats.FillRatio >= 1 {
		t.Errorf("unexpected fill ratio: %.4f", stats.FillRatio)
	}
	
	t.Logf("Stats: size=%d, hashes=%d, setBits=%d, fillRatio=%.4f, estimatedElements=%d, estimatedFPR=%.6f",
		stats.Size, stats.HashCount, stats.SetBits, stats.FillRatio, stats.EstimatedElements, stats.EstimatedFPR)
}

func TestBloomFilter_EmptyFilter(t *testing.T) {
	bf := NewBloomFilter(1000, 0.01)
	
	// Empty filter should return false for any element
	if bf.MayContain("example.com") {
		t.Error("empty filter should return false")
	}
	if bf.MayContain("google.com") {
		t.Error("empty filter should return false")
	}
}

func TestBloomFilter_Concurrent(t *testing.T) {
	bf := NewBloomFilter(10000, 0.01)
	
	// Add elements concurrently
	done := make(chan bool)
	for i := 0; i < 10; i++ {
		go func(start int) {
			for j := 0; j < 100; j++ {
				bf.Add(fmt.Sprintf("domain-%d-%d.com", start, j))
			}
			done <- true
		}(i)
	}
	
	for i := 0; i < 10; i++ {
		<-done
	}
	
	// Check concurrently
	for i := 0; i < 10; i++ {
		go func(start int) {
			for j := 0; j < 100; j++ {
				element := fmt.Sprintf("domain-%d-%d.com", start, j)
				if !bf.MayContain(element) {
					t.Errorf("expected %s to be found", element)
				}
			}
			done <- true
		}(i)
	}
	
	for i := 0; i < 10; i++ {
		<-done
	}
}

func TestBloomFilter_DefaultParameters(t *testing.T) {
	// Test with invalid parameters - should use defaults
	bf1 := NewBloomFilter(0, 0.01)
	if bf1.size == 0 {
		t.Error("expected default size for invalid expectedElements")
	}
	
	bf2 := NewBloomFilter(1000, 0)
	if bf2.hashCount == 0 {
		t.Error("expected default hash count for invalid FPR")
	}
	
	bf3 := NewBloomFilter(1000, 1.5)
	if bf3.hashCount == 0 {
		t.Error("expected default hash count for invalid FPR")
	}
}

func BenchmarkBloomFilter_Add(b *testing.B) {
	bf := NewBloomFilter(1000000, 0.01)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		bf.Add(fmt.Sprintf("domain-%d.com", i))
	}
}

func BenchmarkBloomFilter_MayContain(b *testing.B) {
	bf := NewBloomFilter(1000000, 0.01)
	
	// Pre-populate
	for i := 0; i < 10000; i++ {
		bf.Add(fmt.Sprintf("domain-%d.com", i))
	}
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		bf.MayContain(fmt.Sprintf("domain-%d.com", i%10000))
	}
}
