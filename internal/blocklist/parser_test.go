package blocklist

import (
	"strings"
	"testing"
)

func TestParseDomains(t *testing.T) {
	input := strings.Join([]string{
		"# comment",
		"0.0.0.0 ads.example.com",
		"||tracker.example.net^",
		"example.org",
		"@@||allowed.example.com^",
		"sub.example.com # trailing comment",
		"",
	}, "\n")

	set, err := ParseDomains(strings.NewReader(input))
	if err != nil {
		t.Fatalf("ParseDomains returned error: %v", err)
	}

	assertHas := func(domain string) {
		if _, ok := set[domain]; !ok {
			t.Fatalf("expected %q to be in set", domain)
		}
	}
	assertNot := func(domain string) {
		if _, ok := set[domain]; ok {
			t.Fatalf("did not expect %q to be in set", domain)
		}
	}

	assertHas("ads.example.com")
	assertHas("tracker.example.net")
	assertHas("example.org")
	assertHas("sub.example.com")
	assertNot("allowed.example.com")
}

func TestParseDomainsExtendedAdBlock(t *testing.T) {
	input := strings.Join([]string{
		"||ads.example.com^$important",
		"||tracker.example.net^$script,image",
		"|https://malware.example.org^",
		"||api.ads.example.com^|",
		"||cdn.ads.example.com^$domain=example.com",
		"",
	}, "\n")

	set, err := ParseDomains(strings.NewReader(input))
	if err != nil {
		t.Fatalf("ParseDomains returned error: %v", err)
	}

	assertHas := func(domain string) {
		if _, ok := set[domain]; !ok {
			t.Fatalf("expected %q to be in set", domain)
		}
	}

	assertHas("ads.example.com")
	assertHas("tracker.example.net")
	assertHas("malware.example.org")
	assertHas("api.ads.example.com")
	assertHas("cdn.ads.example.com")
}
