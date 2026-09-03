FROM caddy:2-alpine
WORKDIR /srv
COPY index.html app.js styles.css config.js sw.js manifest.webmanifest ./
COPY deploy/Codespaces.Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
