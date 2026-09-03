package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type baselineRequest struct {
	Source string `json:"source"`
}

type baselineResponse struct {
	OK             bool   `json:"ok"`
	BPS            int64  `json:"bps,omitempty"`
	Bytes          int64  `json:"bytes,omitempty"`
	ElapsedMS      int64  `json:"elapsed_ms,omitempty"`
	HTTPStatus     int    `json:"http_status,omitempty"`
	FinalHost      string `json:"final_host,omitempty"`
	RangeSupported bool   `json:"range_supported"`
	SignedLike     bool   `json:"signed_like"`
	Hint           string `json:"hint,omitempty"`
	Error          string `json:"error,omitempty"`
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "service": "ztorrent-telemetry"})
	})
	mux.HandleFunc("POST /v1/baseline", handleBaseline)

	s := &http.Server{
		Addr:              ":8090",
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	if err := s.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		panic(err)
	}
}

func handleBaseline(w http.ResponseWriter, r *http.Request) {
	var req baselineRequest
	dec := json.NewDecoder(io.LimitReader(r.Body, 64<<10))
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, 400, baselineResponse{OK: false, Error: "invalid request"})
		return
	}

	src := strings.TrimSpace(req.Source)
	u, err := url.Parse(src)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		writeJSON(w, 400, baselineResponse{OK: false, Error: "baseline requires an HTTP(S) URL"})
		return
	}
	if err := validatePublicURL(r.Context(), u); err != nil {
		writeJSON(w, 400, baselineResponse{OK: false, Error: err.Error()})
		return
	}

	signed := looksSigned(u)
	ctx, cancel := context.WithTimeout(r.Context(), 7*time.Second)
	defer cancel()

	client := &http.Client{
		Timeout: 7 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 6 {
				return errors.New("too many redirects")
			}
			return validatePublicURL(req.Context(), req.URL)
		},
	}

	probe, _ := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	probe.Header.Set("User-Agent", "Ztorrent/0.4 baseline-probe")
	probe.Header.Set("Range", "bytes=0-1048575")
	probe.Header.Set("Accept", "*/*")

	started := time.Now()
	resp, err := client.Do(probe)
	if err != nil {
		hint := "The backend could not open this source."
		if signed {
			hint = "This looks like a signed/session URL. It may be tied to the original browser, account, IP address, or an expiring token."
		}
		writeJSON(w, 422, baselineResponse{OK: false, SignedLike: signed, Hint: hint, Error: "source connection failed"})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		hint := fmt.Sprintf("Source returned HTTP %d to the backend.", resp.StatusCode)
		if signed {
			hint += " Signed/session links can be valid in Safari but invalid from a Codespaces server because the server has a different IP/session."
		}
		writeJSON(w, 422, baselineResponse{OK: false, HTTPStatus: resp.StatusCode, SignedLike: signed, Hint: hint, Error: "source rejected baseline probe"})
		return
	}

	n, readErr := io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	elapsed := time.Since(started)
	if readErr != nil || n <= 0 || elapsed <= 0 {
		hint := "The connection opened but no file bytes arrived during the sample."
		if signed {
			hint += " The signed link may not be portable from your phone to the Codespaces backend."
		}
		writeJSON(w, 422, baselineResponse{OK: false, HTTPStatus: resp.StatusCode, SignedLike: signed, Hint: hint, Error: "no sample bytes received"})
		return
	}

	bps := int64(float64(n) / elapsed.Seconds())
	rangeOK := resp.StatusCode == http.StatusPartialContent || strings.Contains(strings.ToLower(resp.Header.Get("Accept-Ranges")), "bytes")
	writeJSON(w, 200, baselineResponse{
		OK:             true,
		BPS:            bps,
		Bytes:          n,
		ElapsedMS:      elapsed.Milliseconds(),
		HTTPStatus:     resp.StatusCode,
		FinalHost:      resp.Request.URL.Hostname(),
		RangeSupported: rangeOK,
		SignedLike:     signed,
		Hint:           "Single-connection sample from the same backend before aria2 acceleration.",
	})
}

func looksSigned(u *url.URL) bool {
	q := u.Query()
	for _, key := range []string{"token", "api-key", "apikey", "signature", "sig", "expires", "expiry", "auth", "key"} {
		if q.Get(key) != "" {
			return true
		}
	}
	return false
}

func validatePublicURL(ctx context.Context, u *url.URL) error {
	host := strings.TrimSpace(u.Hostname())
	if host == "" {
		return errors.New("missing host")
	}
	if ip := net.ParseIP(host); ip != nil {
		if !publicIP(ip) {
			return errors.New("private/internal addresses are blocked")
		}
		return nil
	}
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil || len(ips) == 0 {
		return errors.New("could not resolve source host")
	}
	for _, ip := range ips {
		if !publicIP(ip) {
			return errors.New("private/internal addresses are blocked")
		}
	}
	return nil
}

func publicIP(ip net.IP) bool {
	return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified())
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
