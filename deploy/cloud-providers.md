# Развёртывание в облаке (AWS / GCP / Azure / VPS)

## Общая архитектура

```
[Chrome + Browser MCP]  ←──  [SSH / Tunnel]  ←──  [Ваш компьютер]
        │
        └── Cloudflare Tunnel ──► ChatGPT (облачный)
```

> **Важно:** Browser MCP требует видимый Chrome. В облаке используйте Xvfb
> или Chrome на вашем локальном компьютере + туннель.

---

## AWS EC2

### 1. Создание инстанса

```bash
# CLI
aws ec2 run-instances \
  --image-id ami-0c55b159cbfafe1f0 \
  --instance-type t3.medium \
  --key-name your-key \
  --security-groups browser-mcp-sg \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":20}}]'
```

### 2. Подключение

```bash
ssh -i your-key.pem ubuntu@<public-ip>
```

### 3. Установка

```bash
# Система
sudo apt update && sudo apt upgrade -y
sudo apt install -y nodejs npm git xvfb google-chrome-stable

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Browser MCP
cd /opt
sudo git clone https://github.com/YOUR_USER/human-browser.git
sudo chown -R ubuntu:ubuntu /opt/human-browser
cd /opt/human-browser
npm install
npm run build

# Chrome dependencies
sudo apt install -y libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 \
  libxdamage1 libxrandr2 libgbm1 libasound2

# PM2
sudo npm install -g pm2

# Конфигурация
sudo mkdir -p /etc/browser-mcp
sudo tee /etc/browser-mcp/service.env > /dev/null <<EOF
CDP_ENDPOINT=http://127.0.0.1:9222
CDP_GATEWAY_TOKEN=$(openssl rand -hex 32)
GATEWAY_ENABLED=true
GATEWAY_LISTEN_HOST=0.0.0.0
GATEWAY_ALLOWED_CIDRS=10.0.0.0/8
MCP_TRANSPORT=streamable-http
MCP_LISTEN_HOST=0.0.0.0
MCP_LISTEN_PORT=9230
BROWSER_ALLOWED_DOMAINS=*
LOG_FILE=/var/log/browser-mcp/browser-mcp.log
EOF

# Запуск
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
google-chrome --remote-debugging-port=9222 --no-first-run --no-sandbox \
  --user-data-dir=/tmp/chrome-profile &
sleep 3

pm2 start dist/src/main.js --name browser-mcp --env-file /etc/browser-mcp/service.env
pm2 save && pm2 startup
```

### 4. Security Group

```
Inbound:
  - TCP 22     (SSH)       — 0.0.0.0/0
  - TCP 9230   (MCP)       — 10.0.0.0/8  (только LAN/VPN)
  - TCP 9229   (Gateway)   — 10.0.0.0/8  (если нужен доступ извне)

Outbound:
  - All        (0.0.0.0/0)
```

---

## Google Cloud (GCE)

### 1. Создание инстанса

```bash
gcloud compute instances create browser-mcp \
  --zone=us-central1-a \
  --machine-type=e2-medium \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB
```

### 2. Подключение

```bash
gcloud compute ssh browser-mcp --zone=us-central1-a
```

### 3. Установка

```bash
# Аналогично AWS, но с GCE-specific:
sudo apt install -y google-chrome-stable

# Настройка файрвола
gcloud compute firewall-rules create allow-mcp \
  --allow=tcp:9230 \
  --source-ranges=10.0.0.0/8 \
  --target-tags=browser-mcp
```

---

## Azure VM

### 1. Создание VM

```bash
az vm create \
  --resource-group browser-mcp-rg \
  --name browser-mcp \
  --image Ubuntu2404 \
  --size Standard_B2s \
  --admin-username azureuser \
  --ssh-key-value ~/.ssh/id_rsa.pub
```

### 2. Установка

```bash
# Аналогично AWS
ssh azureuser@<public-ip>
# ... установка Node.js, Chrome, Browser MCP ...
```

### 3. Network Security Group

```
Inbound:
  - SSH    (22)   — Any
  - MCP    (9230) — 10.0.0.0/8
```

---

## DigitalOcean / Hetzner / Любой VPS

### Быстрое развёртывание (скрипт)

```bash
#!/bin/bash
# install-browser-mcp.sh — один скрипт для нового VPS

set -e

echo "=== Установка Browser MCP на $(hostname) ==="

# 1. Система
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git xvfb

# 2. Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Chrome
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt update
sudo apt install -y google-chrome-stable

# 4. Chrome dependencies
sudo apt install -y libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 \
  libxdamage1 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 \
  libgtk-3-0 fonts-liberation xdg-utils

# 5. Browser MCP
cd /opt
sudo git clone https://github.com/YOUR_USER/human-browser.git
sudo chown -R $USER:$USER /opt/human-browser
cd /opt/human-browser
npm install
npm run build

# 6. PM2
sudo npm install -g pm2

# 7. Конфигурация
sudo mkdir -p /etc/browser-mcp
TOKEN=$(openssl rand -hex 32)
sudo tee /etc/browser-mcp/service.env > /dev/null <<EOF
CDP_ENDPOINT=http://127.0.0.1:9222
CDP_GATEWAY_TOKEN=$TOKEN
GATEWAY_ENABLED=true
GATEWAY_LISTEN_HOST=0.0.0.0
GATEWAY_ALLOWED_CIDRS=127.0.0.1/32
MCP_TRANSPORT=streamable-http
MCP_LISTEN_HOST=0.0.0.0
MCP_LISTEN_PORT=9230
BROWSER_ALLOWED_DOMAINS=*
LOG_FILE=/var/log/browser-mcp/browser-mcp.log
EOF

# 8. Запуск
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
google-chrome --remote-debugging-port=9222 --no-first-run --no-sandbox \
  --user-data-dir=/tmp/chrome-profile &
sleep 3

pm2 start dist/src/main.js --name browser-mcp --env-file /etc/browser-mcp/service.env
pm2 save
pm2 startup

# 9. Проверка
curl http://127.0.0.1:9230/healthz

echo ""
echo "=== Установка завершена ==="
echo "Токен: $TOKEN"
echo "MCP: http://127.0.0.1:9230/mcp"
echo ""
```

Использование:

```bash
# Скачайте и запустите на новом VPS:
curl -fsSL https://your-server.com/install-browser-mcp.sh | bash
```

---

## Cloudflare Tunnel (для облачного ChatGPT)

```bash
# Установка cloudflared
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared

# Быстрый тест (туннель с временным URL)
cloudflared tunnel --url http://127.0.0.1:9230

# Постоянный туннель
# Создайте туннель в Cloudflare Zero Trust dashboard
# Скопируйте токен
export CLOUDFLARE_TUNNEL_TOKEN="ваш_токен"
cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

---

## Kubernetes

### Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: browser-mcp
  labels:
    app: browser-mcp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: browser-mcp
  template:
    metadata:
      labels:
        app: browser-mcp
    spec:
      containers:
        - name: browser-mcp
          image: ghcr.io/YOUR_USER/human-browser:latest
          ports:
            - containerPort: 9230
              name: mcp
          env:
            - name: CDP_GATEWAY_TOKEN
              valueFrom:
                secretKeyRef:
                  name: browser-mcp-secrets
                  key: gateway-token
            - name: CDP_ENDPOINT
              value: "http://chrome:9222"
            - name: GATEWAY_ENABLED
              value: "true"
            - name: GATEWAY_LISTEN_HOST
              value: "0.0.0.0"
            - name: GATEWAY_ALLOWED_CIDRS
              value: "10.0.0.0/8"
            - name: MCP_TRANSPORT
              value: "streamable-http"
            - name: MCP_LISTEN_HOST
              value: "0.0.0.0"
            - name: BROWSER_ALLOWED_DOMAINS
              value: "*"
          volumeMounts:
            - name: logs
              mountPath: /app/logs
          readinessProbe:
            httpGet:
              path: /healthz
              port: 9230
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 9230
            initialDelaySeconds: 10
            periodSeconds: 30
      volumes:
        - name: logs
          emptyDir: {}

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: chrome
spec:
  replicas: 1
  selector:
    matchLabels:
      app: chrome
  template:
    metadata:
      labels:
        app: chrome
    spec:
      containers:
        - name: chrome
          image: browserless/chrome:latest
          ports:
            - containerPort: 9222
              name: cdp
          env:
            - name: CONNECTION_TIMEOUT
              value: "300000"
            - name: MAX_CONCURRENT_SESSIONS
              value: "5"
          resources:
            requests:
              memory: "1Gi"
              cpu: "500m"
            limits:
              memory: "2Gi"
              cpu: "1000m"

---
apiVersion: v1
kind: Service
metadata:
  name: chrome
spec:
  selector:
    app: chrome
  ports:
    - port: 9222
      targetPort: 9222

---
apiVersion: v1
kind: Service
metadata:
  name: browser-mcp
spec:
  selector:
    app: browser-mcp
  ports:
    - port: 9230
      targetPort: 9230

---
apiVersion: v1
kind: Secret
metadata:
  name: browser-mcp-secrets
type: Opaque
stringData:
  gateway-token: "ваш_секрет"
```

### Проверка

```bash
kubectl apply -f browser-mcp.yaml
kubectl get pods
kubectl logs -f deployment/browser-mcp
kubectl port-forward service/browser-mcp 9230:9230
curl http://127.0.0.1:9230/healthz
```

---

## Docker Compose (universal)

См. [deploy/docker.md](docker.md) — работает на любом Docker-хосте.

---

## Сравнение провайдеров

| Провайдер | Минимальный инстанс | Стоимость/мес | Плюсы | Минусы |
|-----------|---------------------|---------------|-------|--------|
| **AWS EC2** | t3.medium | ~$30 | Надёжность, IAM | Сложная конфигурация |
| **GCP GCE** | e2-medium | ~$25 | Простота, Free tier | Ограниченный free tier |
| **Azure VM** | Standard_B2s | ~$30 | Интеграция с AD | Сложный CLI |
| **DigitalOcean** | s-2vcpu-4gb | ~$24 | Простота, дёшево | Меньше функций |
| **Hetzner** | CX22 | ~$5 | Самый дешёвый | Только EU |
| **Vultr** | vc2-2c-4gb | ~$24 | Много регионов | Меньше документации |

---

## Рекомендации

1. **Для тестов:** DigitalOcean или Hetzner (самый дешёвый вариант)
2. **Для продакшена:** AWS/GCP с managed Kubernetes
3. **Для personal use:** VPS + Cloudflare Tunnel
4. **Для enterprise:** Kubernetes на AWS EKS / GCP GKE
