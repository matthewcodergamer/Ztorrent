package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type speedProfile struct {
	HTTPConnections string `json:"http_connections"`
	Split           string `json:"split"`
	MinSplitSize    string `json:"min_split_size"`
	BTMaxPeers      string `json:"bt_max_peers"`
	FileAllocation  string `json:"file_allocation"`
	MaxConcurrent   string `json:"max_concurrent_downloads"`
}

type server struct {
	ariaURL, ariaSecret, downloadDir, frontendOrigin string
	profile                                          speedProfile
	httpClient                                       *http.Client
}

type analyzeRequest struct {
	Source string `json:"source"`
}
type rpcRequest struct {
	JSONRPC string        `json:"jsonrpc"`
	ID      string        `json:"id"`
	Method  string        `json:"method"`
	Params  []interface{} `json:"params"`
}
type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}
type ariaStatus struct {
	GID             string `json:"gid"`
	Status          string `json:"status"`
	TotalLength     string `json:"totalLength"`
	CompletedLength string `json:"completedLength"`
	DownloadSpeed   string `json:"downloadSpeed"`
	UploadSpeed     string `json:"uploadSpeed"`
	Connections     string `json:"connections"`
	NumSeeders      string `json:"numSeeders"`
	Seeder          string `json:"seeder"`
	ErrorMessage    string `json:"errorMessage"`
	Bitfield        string `json:"bitfield"`
	Files           []struct {
		Index           string `json:"index"`
		Path            string `json:"path"`
		Length          string `json:"length"`
		CompletedLength string `json:"completedLength"`
		Selected        string `json:"selected"`
	} `json:"files"`
	BT *struct {
		Info *struct {
			Name string `json:"name"`
		} `json:"info"`
	} `json:"bittorrent"`
}

type candidate struct {
	URL            string `json:"url"`
	Filename       string `json:"filename"`
	Size           any    `json:"size,omitempty"`
	ContentType    string `json:"content_type,omitempty"`
	RangeSupported bool   `json:"range_supported"`
	SampleBPS      int64  `json:"sample_bps,omitempty"`
	Score          int64  `json:"-"`
}

var linkRE = regexp.MustCompile(`(?i)(?:href|src)\s*=\s*["']([^"'#]+)["']`)

func main() {
	s := &server{
		ariaURL:        env("ARIA2_RPC_URL", "http://aria2:6800/jsonrpc"),
		ariaSecret:     os.Getenv("ARIA2_RPC_SECRET"),
		downloadDir:    env("DOWNLOAD_DIR", "/downloads"),
		frontendOrigin: os.Getenv("FRONTEND_ORIGIN"),
		profile: speedProfile{
			HTTPConnections: clampIntEnv("ARIA2_HTTP_CONNECTIONS", 16, 1, 16),
			Split:           clampIntEnv("ARIA2_SPLIT", 16, 1, 16),
			MinSplitSize:    env("ARIA2_MIN_SPLIT_SIZE", "1M"),
			BTMaxPeers:      clampIntEnv("ARIA2_BT_MAX_PEERS", 200, 20, 1000),
			FileAllocation:  env("ARIA2_FILE_ALLOCATION", "falloc"),
			MaxConcurrent:   clampIntEnv("ARIA2_MAX_CONCURRENT_DOWNLOADS", 8, 1, 64),
		},
	}
	s.httpClient = &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 8 {
				return errors.New("too many redirects")
			}
			return validatePublicHTTPURL(req.Context(), req.URL)
		},
	}
	s.applyGlobalAriaSettings()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("POST /v1/analyze", s.handleAnalyze)
	mux.HandleFunc("POST /v1/jobs", s.handleCreateJob)
	mux.HandleFunc("GET /v1/jobs/{gid}", s.handleJob)
	mux.HandleFunc("POST /v1/jobs/{gid}/pause", s.handlePause)
	mux.HandleFunc("POST /v1/jobs/{gid}/resume", s.handleResume)
	mux.HandleFunc("POST /v1/jobs/{gid}/cancel", s.handleCancel)
	mux.HandleFunc("GET /v1/jobs/{gid}/file", s.handleFile)

	addr := env("ADDR", ":8080")
	log.Printf("Ztorrent accelerator listening on %s (HTTP connections=%s, split=%s, BT peers=%s)", addr, s.profile.HTTPConnections, s.profile.Split, s.profile.BTMaxPeers)
	log.Fatal(http.ListenAndServe(addr, s.cors(s.securityHeaders(mux))))
}

func (s *server) applyGlobalAriaSettings() {
	opts := map[string]string{
		"max-overall-download-limit": "0",
		"max-overall-upload-limit":   env("ARIA2_MAX_OVERALL_UPLOAD_LIMIT", "2M"),
		"max-concurrent-downloads":    s.profile.MaxConcurrent,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var out string
	if err := s.ariaCall(ctx, "aria2.changeGlobalOption", []interface{}{opts}, &out); err != nil {
		log.Printf("aria2 global tuning will retry implicitly when jobs start: %v", err)
	}
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	var version map[string]any
	ariaOK := s.ariaCall(ctx, "aria2.getVersion", nil, &version) == nil
	writeJSON(w, 200, map[string]any{
		"ok": true, "service": "ztorrent-accelerator", "aria2_ok": ariaOK,
		"profile": s.profile,
		"limits":  map[string]any{"download_limit": "unlimited", "provider_limits_bypassed": false},
	})
}

func (s *server) handleAnalyze(w http.ResponseWriter, r *http.Request) {
	var req analyzeRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	src := strings.TrimSpace(req.Source)
	if strings.HasPrefix(strings.ToLower(src), "magnet:?") {
		u, err := url.Parse(src)
		if err != nil {
			writeError(w, 400, "invalid magnet")
			return
		}
		name := u.Query().Get("dn")
		if name == "" {
			name = "Torrent download"
		}
		writeJSON(w, 200, map[string]any{
			"type": "magnet", "filename": name, "engine": "aria2 BitTorrent — full server swarm",
			"download_source": src, "range_supported": false, "profile": s.profile,
		})
		return
	}
	u, err := url.Parse(src)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		writeError(w, 400, "source must be an HTTP(S) URL or magnet link")
		return
	}
	if err := validatePublicHTTPURL(r.Context(), u); err != nil {
		writeError(w, 400, err.Error())
		return
	}

	typ := "http"
	lp := strings.ToLower(u.Path)
	if strings.HasSuffix(lp, ".torrent") {
		typ = "torrent"
	} else if strings.HasSuffix(lp, ".meta4") || strings.HasSuffix(lp, ".metalink") {
		typ = "metalink"
	}
	meta, err := s.probeHTTP(r.Context(), u.String())
	if err != nil {
		writeJSON(w, 200, map[string]any{"type": typ, "filename": filenameFromURL(u), "download_source": src, "engine": "aria2", "note": "Source accepted; metadata probe failed: " + err.Error(), "profile": s.profile})
		return
	}
	meta["type"] = typ
	meta["download_source"] = meta["final_url"]
	meta["profile"] = s.profile
	meta["engine"] = "aria2 max-throughput HTTP"
	if typ == "torrent" {
		meta["engine"] = "aria2 torrent resolver"
	}
	if typ == "metalink" {
		meta["engine"] = "aria2 Metalink / mirrors"
	}

	ct, _ := meta["content_type"].(string)
	if typ == "http" && strings.Contains(strings.ToLower(ct), "text/html") {
		finalURL, _ := meta["final_url"].(string)
		candidates := s.extractDownloadCandidates(r.Context(), finalURL)
		meta["type"] = "webpage"
		meta["engine"] = "Ztorrent link extractor + aria2"
		meta["candidates"] = candidates
		if len(candidates) > 0 {
			meta["download_source"] = candidates[0].URL
			meta["filename"] = candidates[0].Filename
			meta["range_supported"] = candidates[0].RangeSupported
			meta["size"] = candidates[0].Size
			meta["sample_bps"] = candidates[0].SampleBPS
			meta["note"] = fmt.Sprintf("Found %d likely download links. Fastest sampled candidate selected automatically.", len(candidates))
		} else {
			meta["note"] = "This looks like a webpage, but no direct downloadable resource could be verified without authentication or page-specific interaction."
		}
	}
	writeJSON(w, 200, meta)
}

func (s *server) probeHTTP(ctx context.Context, src string) (map[string]any, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodHead, src, nil)
	req.Header.Set("User-Agent", "Ztorrent/0.2")
	resp, err := s.httpClient.Do(req)
	if err != nil || (resp != nil && (resp.StatusCode == http.StatusMethodNotAllowed || resp.StatusCode == http.StatusForbidden)) {
		if resp != nil {
			resp.Body.Close()
		}
		req, _ = http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
		req.Header.Set("Range", "bytes=0-0")
		req.Header.Set("User-Agent", "Ztorrent/0.2")
		resp, err = s.httpClient.Do(req)
	}
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("source returned HTTP %d", resp.StatusCode)
	}
	size := resp.ContentLength
	if cr := resp.Header.Get("Content-Range"); cr != "" {
		if slash := strings.LastIndex(cr, "/"); slash >= 0 {
			if n, e := strconv.ParseInt(cr[slash+1:], 10, 64); e == nil {
				size = n
			}
		}
	}
	filename := filenameFromDisposition(resp.Header.Get("Content-Disposition"))
	if filename == "" && resp.Request.URL != nil {
		filename = filenameFromURL(resp.Request.URL)
	}
	return map[string]any{
		"filename": filename, "final_url": resp.Request.URL.String(), "size": nullablePositive(size),
		"content_type": resp.Header.Get("Content-Type"), "etag": resp.Header.Get("ETag"), "last_modified": resp.Header.Get("Last-Modified"),
		"range_supported": resp.StatusCode == http.StatusPartialContent || strings.Contains(strings.ToLower(resp.Header.Get("Accept-Ranges")), "bytes"),
	}, nil
}

func (s *server) extractDownloadCandidates(ctx context.Context, pageURL string) []candidate {
	u, err := url.Parse(pageURL)
	if err != nil {
		return nil
	}
	if err := validatePublicHTTPURL(ctx, u); err != nil {
		return nil
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	req.Header.Set("User-Agent", "Ztorrent/0.2")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil
	}
	base := resp.Request.URL
	matches := linkRE.FindAllSubmatch(raw, 300)
	seen := map[string]bool{}
	urls := make([]string, 0, 40)
	for _, m := range matches {
		if len(m) < 2 {
			continue
		}
		ref := strings.TrimSpace(string(m[1]))
		if ref == "" || strings.HasPrefix(ref, "javascript:") || strings.HasPrefix(ref, "data:") {
			continue
		}
		ru, err := url.Parse(ref)
		if err != nil {
			continue
		}
		ru = base.ResolveReference(ru)
		if ru.Scheme != "http" && ru.Scheme != "https" {
			continue
		}
		ru.Fragment = ""
		normalized := ru.String()
		if seen[normalized] || !likelyDownloadURL(ru) {
			continue
		}
		if err := validatePublicHTTPURL(ctx, ru); err != nil {
			continue
		}
		seen[normalized] = true
		urls = append(urls, normalized)
		if len(urls) >= 40 {
			break
		}
	}
	out := make([]candidate, 0, len(urls))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	probeCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	for _, src := range urls {
		src := src
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			meta, err := s.probeHTTP(probeCtx, src)
			if err != nil {
				return
			}
			finalURL, _ := meta["final_url"].(string)
			if finalURL == "" {
				finalURL = src
			}
			cu, _ := url.Parse(finalURL)
			name, _ := meta["filename"].(string)
			if name == "" {
				name = filenameFromURL(cu)
			}
			rangeOK, _ := meta["range_supported"].(bool)
			ct, _ := meta["content_type"].(string)
			size := meta["size"]
			bps := s.sampleSourceSpeed(probeCtx, finalURL, rangeOK)
			score := bps
			if rangeOK {
				score += 50_000
			}
			if looksLikeHTML(ct) {
				score -= 1_000_000_000
			}
			c := candidate{URL: finalURL, Filename: name, Size: size, ContentType: ct, RangeSupported: rangeOK, SampleBPS: bps, Score: score}
			mu.Lock()
			out = append(out, c)
			mu.Unlock()
		}()
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > 12 {
		out = out[:12]
	}
	return out
}

func (s *server) sampleSourceSpeed(ctx context.Context, src string, ranges bool) int64 {
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(cctx, http.MethodGet, src, nil)
	req.Header.Set("User-Agent", "Ztorrent/0.2")
	if ranges {
		req.Header.Set("Range", "bytes=0-524287")
	}
	started := time.Now()
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return 0
	}
	n, _ := io.Copy(io.Discard, io.LimitReader(resp.Body, 512<<10))
	elapsed := time.Since(started)
	if n <= 0 || elapsed <= 0 {
		return 0
	}
	return int64(float64(n) / elapsed.Seconds())
}

func likelyDownloadURL(u *url.URL) bool {
	p := strings.ToLower(u.Path)
	q := strings.ToLower(u.RawQuery)
	exts := []string{".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".iso", ".dmg", ".pkg", ".exe", ".msi", ".apk", ".ipa", ".pdf", ".mp4", ".mkv", ".mov", ".mp3", ".flac", ".wav", ".torrent", ".meta4", ".metalink", ".bin", ".img", ".csv", ".json"}
	for _, e := range exts {
		if strings.HasSuffix(p, e) {
			return true
		}
	}
	return strings.Contains(p, "download") || strings.Contains(p, "attachment") || strings.Contains(p, "releases/download") || strings.Contains(q, "download=") || strings.Contains(q, "dl=")
}
func looksLikeHTML(ct string) bool { return strings.Contains(strings.ToLower(ct), "text/html") }

func (s *server) handleCreateJob(w http.ResponseWriter, r *http.Request) {
	var req analyzeRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	src := strings.TrimSpace(req.Source)
	isMagnet := strings.HasPrefix(strings.ToLower(src), "magnet:?")
	if !isMagnet {
		u, err := url.Parse(src)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			writeError(w, 400, "source must be HTTP(S) or magnet")
			return
		}
		if err := validatePublicHTTPURL(r.Context(), u); err != nil {
			writeError(w, 400, err.Error())
			return
		}
	}
	opts := map[string]string{
		"continue":                  "true",
		"max-connection-per-server": s.profile.HTTPConnections,
		"split":                     s.profile.Split,
		"min-split-size":            s.profile.MinSplitSize,
		"file-allocation":           s.profile.FileAllocation,
		"auto-file-renaming":        "true",
		"allow-overwrite":           "false",
		"follow-torrent":            "mem",
		"follow-metalink":           "mem",
		"max-download-limit":        "0",
		"max-tries":                 "0",
		"retry-wait":                "1",
		"connect-timeout":           "10",
		"timeout":                   "30",
		"lowest-speed-limit":        "0",
		"remote-time":               "true",
		"enable-http-keep-alive":    "true",
		"enable-http-pipelining":    "true",
		"bt-enable-lpd":             "true",
		"enable-dht":                "true",
		"enable-peer-exchange":      "true",
		"bt-save-metadata":          "true",
		"bt-max-peers":              s.profile.BTMaxPeers,
		"bt-tracker-connect-timeout": "10",
		"bt-tracker-timeout":         "30",
		"max-upload-limit":           env("ARIA2_BT_UPLOAD_LIMIT", "2M"),
		"seed-time":                  "0",
	}
	var gid string
	if err := s.ariaCall(r.Context(), "aria2.addUri", []interface{}{[]string{src}, opts}, &gid); err != nil {
		writeError(w, 502, err.Error())
		return
	}
	writeJSON(w, 202, map[string]any{"id": gid, "status": "waiting", "profile": s.profile})
}

func (s *server) handleJob(w http.ResponseWriter, r *http.Request) {
	st, err := s.getStatus(r.Context(), r.PathValue("gid"))
	if err != nil {
		writeError(w, 502, err.Error())
		return
	}
	out := normalizeStatus(st)
	out["profile"] = s.profile
	writeJSON(w, 200, out)
}
func (s *server) handlePause(w http.ResponseWriter, r *http.Request) {
	s.simpleAriaAction(w, r, "aria2.pause")
}
func (s *server) handleResume(w http.ResponseWriter, r *http.Request) {
	s.simpleAriaAction(w, r, "aria2.unpause")
}
func (s *server) handleCancel(w http.ResponseWriter, r *http.Request) {
	s.simpleAriaAction(w, r, "aria2.remove")
}
func (s *server) simpleAriaAction(w http.ResponseWriter, r *http.Request, method string) {
	var out string
	if err := s.ariaCall(r.Context(), method, []interface{}{r.PathValue("gid")}, &out); err != nil {
		writeError(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "id": out})
}

func (s *server) handleFile(w http.ResponseWriter, r *http.Request) {
	st, err := s.getStatus(r.Context(), r.PathValue("gid"))
	if err != nil {
		writeError(w, 502, err.Error())
		return
	}
	if st.Status != "complete" {
		writeError(w, 409, "download is not complete")
		return
	}
	if len(st.Files) != 1 {
		writeError(w, 409, "multi-file torrent delivery is not yet packaged; select a single-file job")
		return
	}
	p := filepath.Clean(st.Files[0].Path)
	base, _ := filepath.Abs(s.downloadDir)
	abs, _ := filepath.Abs(p)
	if abs != base && !strings.HasPrefix(abs, base+string(os.PathSeparator)) {
		writeError(w, 403, "unsafe output path")
		return
	}
	f, err := os.Open(abs)
	if err != nil {
		writeError(w, 404, "downloaded file not found")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeError(w, 500, "could not stat downloaded file")
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(abs)))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, filepath.Base(abs), info.ModTime(), f)
}

func (s *server) getStatus(ctx context.Context, gid string) (*ariaStatus, error) {
	if gid == "" {
		return nil, errors.New("missing job id")
	}
	var st ariaStatus
	fields := []string{"gid", "status", "totalLength", "completedLength", "downloadSpeed", "uploadSpeed", "connections", "numSeeders", "seeder", "errorMessage", "files", "bittorrent"}
	if err := s.ariaCall(ctx, "aria2.tellStatus", []interface{}{gid, fields}, &st); err != nil {
		return nil, err
	}
	return &st, nil
}
func normalizeStatus(st *ariaStatus) map[string]any {
	total, _ := strconv.ParseInt(st.TotalLength, 10, 64)
	done, _ := strconv.ParseInt(st.CompletedLength, 10, 64)
	speed, _ := strconv.ParseInt(st.DownloadSpeed, 10, 64)
	up, _ := strconv.ParseInt(st.UploadSpeed, 10, 64)
	conns, _ := strconv.Atoi(st.Connections)
	seeders, _ := strconv.Atoi(st.NumSeeders)
	name := ""
	if st.BT != nil && st.BT.Info != nil {
		name = st.BT.Info.Name
	}
	if name == "" && len(st.Files) > 0 {
		name = filepath.Base(st.Files[0].Path)
	}
	return map[string]any{"id": st.GID, "status": st.Status, "total_bytes": total, "completed_bytes": done, "download_speed": speed, "upload_speed": up, "connections": conns, "seeders": seeders, "is_torrent": st.BT != nil, "filename": name, "error_message": st.ErrorMessage}
}

func (s *server) ariaCall(ctx context.Context, method string, params []interface{}, out interface{}) error {
	if params == nil {
		params = []interface{}{}
	}
	if s.ariaSecret != "" {
		params = append([]interface{}{"token:" + s.ariaSecret}, params...)
	}
	payload, _ := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: "ztorrent", Method: method, Params: params})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, s.ariaURL, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("aria2 RPC unavailable: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return err
	}
	var rr rpcResponse
	if err := json.Unmarshal(body, &rr); err != nil {
		return fmt.Errorf("invalid aria2 response")
	}
	if rr.Error != nil {
		return fmt.Errorf("aria2: %s", rr.Error.Message)
	}
	if out != nil {
		return json.Unmarshal(rr.Result, out)
	}
	return nil
}

func validatePublicHTTPURL(ctx context.Context, u *url.URL) error {
	if u == nil || (u.Scheme != "http" && u.Scheme != "https") {
		return errors.New("only HTTP(S) sources are allowed")
	}
	if u.User != nil {
		return errors.New("credentials in source URLs are not supported")
	}
	host := u.Hostname()
	if host == "" {
		return errors.New("URL has no host")
	}
	if strings.EqualFold(host, "localhost") {
		return errors.New("local/private targets are blocked")
	}
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return fmt.Errorf("could not resolve source host")
	}
	for _, ip := range ips {
		if isPrivateOrSpecial(ip) {
			return errors.New("local/private targets are blocked")
		}
	}
	return nil
}
func isPrivateOrSpecial(ip net.IP) bool {
	return ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast()
}
func filenameFromURL(u *url.URL) string {
	if u == nil {
		return "download"
	}
	base := filepath.Base(strings.TrimSuffix(u.Path, "/"))
	if base == "." || base == "/" || base == "" {
		return "download"
	}
	if decoded, err := url.PathUnescape(base); err == nil {
		base = decoded
	}
	return base
}
func filenameFromDisposition(v string) string {
	_, params, err := mime.ParseMediaType(v)
	if err == nil {
		return filepath.Base(params["filename"])
	}
	return ""
}
func nullablePositive(n int64) any {
	if n > 0 {
		return n
	}
	return nil
}
func readJSON(r *http.Request, dst interface{}) error {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return errors.New("invalid JSON request")
	}
	return nil
}
func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}
func (s *server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		allowed := s.frontendOrigin
		if allowed == "" {
			allowed = "https://matthewcodergamer.github.io"
		}
		if origin == allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (s *server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}
func env(k, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return fallback
}
func clampIntEnv(k string, def, min, max int) string {
	n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(k)))
	if err != nil {
		n = def
	}
	if n < min {
		n = min
	}
	if n > max {
		n = max
	}
	return strconv.Itoa(n)
}
