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
    curl \
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

RUN groupadd -r mcpuser && useradd -r -g mcpuser -G audio,video mcpuser \
    && mkdir -p /home/mcpuser/app /app/logs \
    && chown -R mcpuser:mcpuser /app
USER mcpuser

EXPOSE 9229 9230

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://127.0.0.1:9230/healthz || exit 1

CMD ["node", "dist/src/main.js"]
