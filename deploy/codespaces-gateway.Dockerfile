FROM caddy:2-alpine
WORKDIR /srv
COPY index.html app.js styles.css config.js sw.js manifest.webmanifest ./
COPY deploy/telemetry.js ./telemetry.js
RUN sed -i 's#<script src="./app.js?v=0.3.1" defer></script>#<script src="./telemetry.js?v=0.4" defer></script>\n  <script src="./app.js?v=0.3.1" defer></script>#' index.html
COPY deploy/Codespaces.Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
