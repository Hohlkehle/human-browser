#!/bin/bash
# install-browser-mcp.sh — быстрая установка Browser MCP на чистый VPS
# Использование: curl -fsSL https://your-server.com/install-browser-mcp.sh | bash
set -e

echo "=== Установка Browser MCP на $(hostname) ==="

# Определяем OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    echo "Неизвестная ОС. Поддерживаются Ubuntu/Debian."
    exit 1
fi

if [ "$OS" != "ubuntu" ] && [ "$OS" != "debian" ]; then
    echo "Поддерживаются только Ubuntu/Debian. Текущая ОС: $OS"
    exit 1
fi

# 1. Система
echo ">>> Обновление системы..."
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git xvfb

# 2. Node.js 22
echo ">>> Установка Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Chrome
echo ">>> Установка Google Chrome..."
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt update
sudo apt install -y google-chrome-stable

# 4. Chrome dependencies
echo ">>> Установка зависимостей Chrome..."
sudo apt install -y libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 \
  libxdamage1 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 \
  libgtk-3-0 fonts-liberation xdg-utils

# 5. Browser MCP
echo ">>> Клонирование Browser MCP..."
cd /opt
sudo git clone https://github.com/YOUR_USER/human-browser.git
sudo chown -R $USER:$USER /opt/human-browser
cd /opt/human-browser

echo ">>> Установка зависимостей..."
npm install

echo ">>> Сборка проекта..."
npm run build

echo ">>> Запуск тестов..."
npm test

# 6. PM2
echo ">>> Установка PM2..."
sudo npm install -g pm2

# 7. Конфигурация
echo ">>> Создание конфигурации..."
sudo mkdir -p /etc/browser-mcp /var/log/browser-mcp

TOKEN=$(openssl rand -hex 32)

sudo tee /etc/browser-mcp/service.env > /dev/null <<EOF
CDP_ENDPOINT=http://127.0.0.1:9222
CDP_GATEWAY_TOKEN=$TOKEN
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

# 8. Запуск
echo ">>> Запуск Chrome в Xvfb..."
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
google-chrome --remote-debugging-port=9222 --no-first-run --no-sandbox \
  --user-data-dir=/tmp/chrome-profile &
sleep 3

echo ">>> Запуск Browser MCP через PM2..."
cd /opt/human-browser
pm2 start dist/src/main.js \
  --name browser-mcp \
  --env-file /etc/browser-mcp/service.env \
  --max-memory-restart 500M \
  --log /var/log/browser-mcp/pm2.log

pm2 save
pm2 startup

# 9. Проверка
echo ">>> Проверка healthcheck..."
sleep 2
if curl -sf http://127.0.0.1:9230/healthz > /dev/null; then
    STATUS="OK"
else
    STATUS="FAILED"
fi

echo ""
echo "============================================="
echo "  Установка Browser MCP завершена!"
echo "============================================="
echo ""
echo "  Статус:        $STATUS"
echo "  Токен:         $TOKEN"
echo "  MCP endpoint:  http://127.0.0.1:9230/mcp"
echo "  Gateway:       http://127.0.0.1:9229"
echo "  Logs:          /var/log/browser-mcp/"
echo ""
echo "  Управление:"
echo "    pm2 status              — статус"
echo "    pm2 restart browser-mcp — перезапуск"
echo "    pm2 logs browser-mcp    — логи"
echo "    pm2 stop browser-mcp    — остановка"
echo ""
echo "  Сохраните токен в безопасном месте!"
echo "============================================="
