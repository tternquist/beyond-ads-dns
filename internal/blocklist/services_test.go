package blocklist

import (
	"reflect"
	"sort"
	"testing"
)

func TestDomainsForServices(t *testing.T) {
	// Single service: tiktok
	got := DomainsForServices([]string{"tiktok"})
	want := []string{"amemv.com", "byteoversea.com", "musically.com", "snssdk.com", "tiktok.com", "tiktokapi.com", "tiktokcdn-us.com", "tiktokcdn.com", "tiktokv.com"}
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("DomainsForServices([\"tiktok\"]) = %v, want %v", got, want)
	}

	// Unknown service returns empty
	got = DomainsForServices([]string{"unknown"})
	if len(got) != 0 {
		t.Errorf("DomainsForServices([\"unknown\"]) = %v, want []", got)
	}

	// Union of two services
	got = DomainsForServices([]string{"tiktok", "youtube"})
	if len(got) < 10 {
		t.Errorf("DomainsForServices([\"tiktok\", \"youtube\"]) should have 15 domains, got %d", len(got))
	}
	gotSet := make(map[string]struct{})
	for _, d := range got {
		gotSet[d] = struct{}{}
	}
	for _, d := range want {
		if _, ok := gotSet[d]; !ok {
			t.Errorf("DomainsForServices union missing %q", d)
		}
	}
	if _, ok := gotSet["youtube.com"]; !ok {
		t.Errorf("DomainsForServices union missing youtube.com")
	}
}
