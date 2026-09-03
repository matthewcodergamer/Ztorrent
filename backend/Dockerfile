FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
COPY compat.go ./

# Keep the main API source compact while applying the runtime HTTP compatibility
# hooks here. Signed/session-style URLs start conservatively instead of being
# hit with 16 parallel requests immediately; ordinary URLs retain the configured
# high-throughput profile. Also expose aria2's real error code to the UI/API.
RUN sed -i \
  -e 's/"max-connection-per-server": s.profile.HTTPConnections,/"max-connection-per-server": httpJobConnections(src, isMagnet, s.profile.HTTPConnections),/' \
  -e 's/"split":                     s.profile.Split,/"split":                     httpJobSplit(src, isMagnet, s.profile.Split),/' \
  -e 's/"enable-http-pipelining":    "true",/"enable-http-pipelining":    httpJobPipelining(src, isMagnet),/' \
  main.go && \
  sed -i '/"enable-http-pipelining":    httpJobPipelining(src, isMagnet),/a\		"user-agent":                httpJobUserAgent(src, isMagnet),' main.go && \
  sed -i '/ErrorMessage    string `json:"errorMessage"`/a\	ErrorCode       string `json:"errorCode"`' main.go && \
  sed -i 's/"errorMessage", "files"/"errorMessage", "errorCode", "files"/' main.go && \
  sed -i 's/"error_message": st.ErrorMessage}/"error_message": st.ErrorMessage, "error_code": st.ErrorCode}/' main.go

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /ztorrent-api .

FROM alpine:3.21
RUN adduser -D -u 10001 ztorrent && mkdir -p /downloads && chown -R ztorrent:ztorrent /downloads
USER ztorrent
COPY --from=build /ztorrent-api /usr/local/bin/ztorrent-api
ENV ADDR=:8080 DOWNLOAD_DIR=/downloads
EXPOSE 8080
ENTRYPOINT ["ztorrent-api"]
