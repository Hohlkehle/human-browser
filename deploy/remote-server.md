# Развёртывание на удалённом Linux-сервере

## Архитектура

```
[Ваш компьютер]                    [Удалённый сервер (Ubuntu)]
Chrome ──CDP──► Browser MCP ──Tunnel──► Cloudflare Edge ──► ChatGPT
  │                  │
  │            MCP (127.0.0.1:9230)
  │                  │
  └── SSH tunnel ────┘  (альтернатива туннелю)
```

> **Важно:** Browser MCP требует **видимый** (не headless) Chrome. На headless-сервере
> используйте Xvfb (виртуальный framebuffer) или подключайте Chrome с вашего компьютера.

## Установка на Ubuntu/Debian

### 1. Подготовка сервера

```bash
# SSH на сервер
ssh user@your-server-ip

# Обновите систему
sudo apt update && sudo apt upgrade -y

# Установите Node.js 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Проверьте версию
node --version   # >= 22

# Установите Git
sudo apt install -y git

# Установите Chrome
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt update
sudo apt install -y google-chrome-stable

# Установите зависимости для Chrome
sudo apt install -y libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 \
  libxdamage1 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 \
  libgtk-3-0 fonts-liberation xdg-utils

# Установите Xvfb (виртуальный дисплей для headless-сервера)
sudo apt install -y xvfb

# Установите pm2 (процесс-менеджер)
sudo npm install -g pm2
```

### 2. Клонирование и сборка

```bash
# Клонируйте репозиторий
cd /opt
sudo git clone https://github.com/YOUR_USER/human-browser.git
sudo chown -R $USER:$USER /opt/human-browser
cd /opt/human-browser

# Установите зависимости
npm install

# Соберите проект
npm run build

# Запустите тесты
npm test
```

### 3. Конфигурация

```bash
# Создайте файл конфигурации
sudo mkdir -p /etc/browser-mcp
sudo tee /etc/browser-mcp/service.env > /dev/null <<EOF
CDP_ENDPOINT=http://127.0.0.1:9222
CDP_GATEWAY_TOKEN=$(openssl rand -hex 32)
GATEWAY_ENABLED=true
GATEWAY_LISTEN_HOST=0.0.0.0
GATEWAY_ALLOWED_CIDRS=127.0.0.1/32,10.0.0.0/8
GATEWAY_LISTEN_PORT=9229
MCP_TRANSPORT=streamable-http
MCP_LISTEN_HOST=0.0.0.0
MCP_LISTEN_PORT=9230
BROWSER_ALLOWED_DOMAINS=*
LOG_FILE=/var/log/browser-mcp/browser-mcp.log
LOG_LEVEL=info
EOF

# Сохраните токен (он понадобится для подключения)
echo "Ваш токен: $(grep CDP_GATEWAY_TOKEN /etc/browser-mcp/service.env | cut -d= -f2)"

# Создайте директорию для логов
sudo mkdir -p /var/log/browser-mcp
sudo chown $USER:$USER /var/log/browser-mcp
```

### 4. Запуск через Xvfb + PM2

```bash
# Запустите виртуальный дисплей
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99

# Запустите Chrome в виртуальном дисплее
google-chrome --remote-debugging-port=9222 \
  --no-first-run \
  --disable-gpu \
  --no-sandbox \
  --user-data-dir=/tmp/chrome-profile &
sleep 3

# Запустите Browser MCP через PM2
cd /opt/human-browser
pm2 start dist/src/main.js \
  --name browser-mcp \
  --env-file /etc/browser-mcp/service.env \
  --max-memory-restart 500M \
  --log /var/log/browser-mcp/pm2.log

# Сохраните конфигурацию PM2
pm2 save
pm2 startup
```

### 5. Проверка

```bash
# Проверьте healthcheck
curl http://127.0.0.1:9230/healthz
# Ответ: {"status":"ok"}

# Проверьте, что MCP работает
curl -X POST http://127.0.0.1:9230/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}'
```

## Доступ извне

### Вариант A: SSH-туннель (рекомендуется)

Безопасный способ — пробросить порт через SSH:

```bash
# С вашего компьютера:
ssh -L 9230:127.0.0.1:9230 user@your-server-ip

# Теперь MCP доступен на вашем компьютере:
# http://127.0.0.1:9230/mcp
```

### Вариант B: Cloudflare Tunnel

```bash
# На сервере:
# 1. Установите cloudflared
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared

# 2. Настройте токен
export CLOUDFLARE_TUNNEL_TOKEN="ваш_токен_туннеля"

# 3. Запустите туннель через PM2
pm2 start cloudflared -- tunnel run --url http://127.0.0.1:9230 --token $CLOUDFLARE_TUNNEL_TOKEN --name tunnel

# 4. Сохраните
pm2 save
```

### Вариант C: Nginx reverse proxy (для LAN)

```bash
sudo apt install -y nginx

sudo tee /etc/nginx/sites-available/browser-mcp > /dev/null <<EOF
server {
    listen 443 ssl;
    server_name browser-mcp.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/browser-mcp.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/browser-mcp.yourdomain.com/privkey.pem;

    location /mcp {
        proxy_pass http://127.0.0.1:9230;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 300s;
    }

    location /healthz {
        proxy_pass http://127.0.0.1:9230;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/browser-mcp /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## Systemd-сервис (альтернатива PM2)

```bash
sudo tee /etc/systemd/system/browser-mcp.service > /dev/null <<EOF
[Unit]
Description=Browser MCP Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=/opt/human-browser
EnvironmentFile=/etc/browser-mcp/service.env
ExecStart=/usr/bin/node dist/src/main.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# Безопасность
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/log/browser-mcp /opt/human-browser
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable browser-mcp
sudo systemctl start browser-mcp
sudo systemctl status browser-mcp
```

## Обновление

```bash
cd /opt/human-browser

# Остановите сервис
pm2 stop browser-mcp

# Обновите код
git pull

# Переустановите зависимости (если изменились)
npm install

# Пересоберите
npm run build

# Запустите
pm2 start browser-mcp

# Или через systemd:
# sudo systemctl restart browser-mcp
```

## Удаление

```bash
pm2 delete browser-mcp
pm2 save
sudo rm -rf /opt/human-browser
sudo rm /etc/systemd/system/browser-mcp.service
sudo systemctl daemon-reload
sudo rm -rf /etc/browser-mcp
```
