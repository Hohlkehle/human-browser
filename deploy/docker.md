# Docker-развёртывание

## Предварительные требования

- Docker >= 20.10
- Docker Compose >= 2.0 (опционально)

## Dockerfile

Создайте `Dockerfile` в корне проекта:

```dockerfile
# ---- Stage 1: Build ----
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- Stage 2: Production ----
FROM node:22-slim AS production

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist/ ./dist/

# Не запускать от root
RUN groupadd -r mcpuser && useradd -r -g mcpuser -G audio,video mcpuser \
    && mkdir -p /home/mcpuser/app \
    && chown -R mcpuser:mcpuser /app
USER mcpuser

EXPOSE 9229 9230

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://127.0.0.1:9230/healthz || exit 1

CMD ["node", "dist/src/main.js"]
```

## Docker Compose

Создайте `docker-compose.yml`:

```yaml
version: "3.8"

services:
  browser-mcp:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: browser-mcp
    restart: unless-stopped
    ports:
      - "127.0.0.1:9230:9230"   # MCP (только localhost)
      # - "127.0.0.1:9229:9229" # CDP Gateway (если нужен доступ извне)
    environment:
      - CDP_GATEWAY_TOKEN=${CDP_GATEWAY_TOKEN}
      - CDP_ENDPOINT=http://chrome:9222
      - GATEWAY_ENABLED=true
      - GATEWAY_LISTEN_HOST=0.0.0.0
      - GATEWAY_ALLOWED_CIDRS=172.16.0.0/12
      - MCP_TRANSPORT=streamable-http
      - MCP_LISTEN_HOST=0.0.0.0
      - MCP_LISTEN_PORT=9230
      - BROWSER_ALLOWED_DOMAINS=*
      - LOG_FILE=/app/logs/browser-mcp.log
      - LOG_LEVEL=info
    volumes:
      - mcp-logs:/app/logs
    depends_on:
      chrome:
        condition: service_healthy
    networks:
      - mcp-net

  chrome:
    image: browserless/chrome:latest
    container_name: chrome
    restart: unless-stopped
    ports:
      - "127.0.0.1:9222:9222"
    environment:
      - CONNECTION_TIMEOUT=300000
      - MAX_CONCURRENT_SESSIONS=5
      - MAX_QUEUE_LENGTH=20
    healthcheck:
      test: ["CMD", "curl", "-f", "http://127.0.0.1:9222/json/version"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s
    shm_size: "2gb"
    networks:
      - mcp-net

volumes:
  mcp-logs:

networks:
  mcp-net:
    driver: bridge
```

## Запуск

```bash
# 1. Создайте .env файл
cp .env.example .env
# Задайте CDP_GATEWAY_TOKEN

# 2. Соберите и запустите
docker compose up -d --build

# 3. Проверьте статус
docker compose ps
curl http://127.0.0.1:9230/healthz

# 4. Просмотр логов
docker compose logs -f browser-mcp
```

## Режим STDIO (без HTTP)

Если нужен STDIO-режим (для локальных MCP-клиентов через Docker):

```yaml
services:
  browser-mcp:
    build: .
    stdin_open: true
    tty: true
    environment:
      - MCP_TRANSPORT=stdio
      - CDP_ENDPOINT=http://chrome:9222
      - GATEWAY_ENABLED=true
      - GATEWAY_LISTEN_HOST=0.0.0.0
      - GATEWAY_ALLOWED_CIDRS=172.16.0.0/12
      - CDP_GATEWAY_TOKEN=${CDP_GATEWAY_TOKEN}
    networks:
      - mcp-net
```

Запуск:

```bash
docker compose run --rm browser-mcp
```

## Docker без Compose

```bash
# Сборка
docker build -t browser-mcp .

# Запуск Chrome (отдельно)
docker run -d --name chrome \
  -p 127.0.0.1:9222:9222 \
  browserless/chrome:latest

# Запуск Browser MCP
docker run -d --name browser-mcp \
  -p 127.0.0.1:9230:9230 \
  -e CDP_GATEWAY_TOKEN=ваш_секрет \
  -e CDP_ENDPOINT=http://chrome:9222 \
  --link chrome \
  browser-mcp
```

## Белый-label Docker (для распространения)

Для публикации в Docker Hub или приватный реестр:

```bash
# Тегирование
docker tag browser-mcp your-registry/browser-mcp:0.1.0
docker tag browser-mcp your-registry/browser-mcp:latest

# Пуш
docker push your-registry/browser-mcp:0.1.0
docker push your-registry/browser-mcp:latest
```

Пользователи устанавливают:

```bash
docker pull your-registry/browser-mcp:latest
docker run -e CDP_GATEWAY_TOKEN=secret -p 127.0.0.1:9230:9230 your-registry/browser-mcp
```

## Обновление

```bash
docker compose pull
docker compose up -d --build
```

## Устранение неполадок

| Проблема | Решение |
|----------|---------|
| Chrome не запускается в контейнере | Увеличьте `shm_size: "2gb"` |
| `ECONNREFUSED` к Chrome | Убедитесь, что Chrome контейнер здоров (`docker compose ps`) |
| Логи пусты | Проверьте `docker compose logs chrome` |
| MCP недоступен | Проверьте `docker compose logs browser-mcp` |
