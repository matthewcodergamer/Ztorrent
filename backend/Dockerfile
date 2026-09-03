FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /ztorrent-api .

FROM alpine:3.21
RUN adduser -D -u 10001 ztorrent && mkdir -p /downloads && chown -R ztorrent:ztorrent /downloads
USER ztorrent
COPY --from=build /ztorrent-api /usr/local/bin/ztorrent-api
ENV ADDR=:8080 DOWNLOAD_DIR=/downloads
EXPOSE 8080
ENTRYPOINT ["ztorrent-api"]
