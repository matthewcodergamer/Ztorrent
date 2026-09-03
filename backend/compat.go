package main

import (
	"net/url"
	"strings"
)

// looksSignedHTTP identifies temporary/session-style URLs. These links are
// commonly more sensitive to concurrent requests than ordinary static files.
// Ztorrent does not bypass their authorization; it simply uses a conservative
// HTTP transport profile so an otherwise valid authorized link is not broken
// by our own parallelism.
func looksSignedHTTP(src string) bool {
	u, err := url.Parse(strings.TrimSpace(src))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	q := u.Query()
	for _, key := range []string{"token", "api-key", "apikey", "signature", "sig", "expires", "expiry", "auth", "key"} {
		if q.Get(key) != "" {
			return true
		}
	}
	return false
}

func httpJobConnections(src string, isMagnet bool, configured string) string {
	if isMagnet {
		return configured
	}
	if looksSignedHTTP(src) {
		return "1"
	}
	return configured
}

func httpJobSplit(src string, isMagnet bool, configured string) string {
	if isMagnet {
		return configured
	}
	if looksSignedHTTP(src) {
		return "1"
	}
	return configured
}

func httpJobPipelining(src string, isMagnet bool) string {
	// HTTP pipelining is not needed for parallel range downloads and is a
	// compatibility problem for a number of proxies/CDNs. Keep it off.
	return "false"
}

func httpJobUserAgent(src string, isMagnet bool) string {
	if isMagnet {
		return "Ztorrent/0.8"
	}
	// Match the benign backend probe identity. This avoids a source accepting
	// the probe but rejecting the actual aria2 request solely because aria2
	// advertises a different default client identity.
	return "Ztorrent/0.4 baseline-probe"
}
