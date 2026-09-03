FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /ztorrent-telemetry .

FROM alpine:3.21
RUN adduser -D -u 10002 ztorrent
USER ztorrent
COPY --from=build /ztorrent-telemetry /usr/local/bin/ztorrent-telemetry
EXPOSE 8090
ENTRYPOINT ["ztorrent-telemetry"]
