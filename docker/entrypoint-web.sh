#!/bin/sh
set -eu

CERT_DIR="${TLS_CERT_DIR:-/etc/nginx/certs}"
CERT_FILE="${CERT_DIR}/server.crt"
KEY_FILE="${CERT_DIR}/server.key"

mkdir -p "$CERT_DIR" /var/www/acme /etc/nginx/conf.d

# Generate a self-signed cert on first run if none exists.
if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "[entrypoint-web] No TLS cert found at $CERT_DIR — generating self-signed cert"
  openssl req -x509 -nodes -newkey rsa:2048 \
    -days "${TLS_SELFSIGNED_DAYS:-365}" \
    -subj "/CN=${TLS_HOSTNAME:-change-mgmt.local}" \
    -keyout "$KEY_FILE" \
    -out "$CERT_FILE" >/dev/null 2>&1
  chmod 600 "$KEY_FILE"
fi

if [ "${DISABLE_TLS:-false}" = "true" ]; then
  echo "[entrypoint-web] TLS disabled — serving HTTP only on :80"
  cat > /etc/nginx/conf.d/redirect-or-serve.conf <<'EOF'
location / {
  root /usr/share/nginx/html;
  try_files $uri $uri/ /index.html;
}
location /api/ {
  proxy_pass http://api_upstream;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Connection "";
  proxy_read_timeout 120s;
}
EOF
  : > /etc/nginx/conf.d/tls-server.conf
else
  echo "[entrypoint-web] TLS enabled — redirecting :80 -> :443 and serving on :443"
  cat > /etc/nginx/conf.d/redirect-or-serve.conf <<'EOF'
location / {
  return 301 https://$host$request_uri;
}
EOF
  cat > /etc/nginx/conf.d/tls-server.conf <<EOF
server {
  listen 443 ssl;
  listen [::]:443 ssl;
  http2 on;
  server_name _;

  ssl_certificate     ${CERT_FILE};
  ssl_certificate_key ${KEY_FILE};
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers on;
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 1d;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;

  location / {
    root /usr/share/nginx/html;
    try_files \$uri \$uri/ /index.html;
  }

  location /api/ {
    proxy_pass http://api_upstream;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Connection "";
    proxy_read_timeout 120s;
  }
}
EOF
fi

echo "[entrypoint-web] Starting nginx"
exec nginx -g 'daemon off;'
