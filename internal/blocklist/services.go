package blocklist

import "strings"

// ServiceDomains maps blockable service IDs to their domain lists.
// Must match BLOCKABLE_SERVICES in web/client/src/utils/constants.js.
// Sources: Pi-hole/Diversion lists, hagezi blocklists, service documentation.
var ServiceDomains = map[string][]string{
	"tiktok":   {"tiktok.com", "tiktokv.com", "tiktokcdn.com", "tiktokcdn-us.com", "byteoversea.com", "musically.com", "snssdk.com", "amemv.com", "tiktokapi.com"},
	"roblox":   {"roblox.com", "rbxcdn.com", "roblox.cn", "rbx.com"},
	"youtube":  {"youtube.com", "googlevideo.com", "ytimg.com", "youtube-nocookie.com", "youtubei.com", "youtubeeducation.com"},
	"instagram": {"instagram.com", "cdninstagram.com", "instagramstatic.com"},
	"netflix":  {"netflix.com", "nflxvideo.net", "nflxext.com", "nflxso.net", "nflximg.net", "netflixdnstest.com"},
	"facebook": {"facebook.com", "fbcdn.net", "fb.com", "fbcdn.com"},
	"snapchat": {"snapchat.com", "sc-cdn.net", "snap-dev.net"},
	"twitter":  {"twitter.com", "x.com", "twimg.com", "t.co", "pscp.tv", "periscope.tv"},
	"discord":  {"discord.com", "discordapp.com", "discord.gg", "discord.media"},
	"twitch":   {"twitch.tv", "ttvnw.net", "jtvnw.net", "twitchcdn.net"},
	"reddit":   {"reddit.com", "redditmedia.com", "redd.it", "redditstatic.com"},
	"pinterest": {"pinterest.com", "pinimg.com"},
	"whatsapp": {"whatsapp.com", "whatsapp.net"},
	"telegram": {"telegram.org", "t.me", "telegra.ph"},
	"linkedin": {"linkedin.com", "licdn.com"},
	"spotify":  {"spotify.com", "scdn.co", "spotifycdn.com"},
	"fortnite": {"fortnite.com", "epicgames.com", "epicgames.dev", "epicgamesstore.com"},
}

// DomainsForServices returns the union of domains for the given service IDs.
// Unknown IDs are ignored.
func DomainsForServices(serviceIDs []string) []string {
	seen := make(map[string]struct{})
	for _, id := range serviceIDs {
		id = strings.ToLower(strings.TrimSpace(id))
		if id == "" {
			continue
		}
		for _, d := range ServiceDomains[id] {
			seen[d] = struct{}{}
		}
	}
	out := make([]string, 0, len(seen))
	for d := range seen {
		out = append(out, d)
	}
	return out
}
