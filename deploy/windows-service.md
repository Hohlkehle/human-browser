# Windows-служба — развёртывание

Используйте встроенные PowerShell-скрипты из `scripts/windows/` для развёртывания
Browser MCP как permanently работающей Windows-службы.

## Архитектура

```
Windows Service (BrowserMcp)
    │
    ├── C# Wrapper (BrowserMcp.Service.exe)
    │     ├── Graceful CTRL_C shutdown
    │     └── Crash restart
    │
    ├── Node.js Process
    │     ├── CDP Gateway (0.0.0.0:9229)
    │     └── MCP Server (127.0.0.1:9230)
    │
    └── Service Account (bmcp-svc)
          └── Secrets в Credential Manager
```

## Предварительные требования

- Windows 10/11 или Windows Server 2019+
- PowerShell 5.1+ (запуск от администратора)
- Node.js 22+ установлен
- Chrome установлен

## Быстрая установка

```powershell
# 1. Откройте PowerShell от администратора
# 2. Перейдите в директорию проекта
cd E:\souce\human-browser

# 3. Убедитесь, что проект собран
npm run build

# 4. Запустите установщик
.\scripts\windows\install.ps1 -Subnet 192.168.88.0/24 -GatewayToken 'ваш_длинный_секрет'
```

## Что делает install.ps1

1. **Создаёт сервисную учётную запись** `bmcp-svc` (без права входа, только service logon)
2. **Хранит секреты** в Windows Credential Manager учётной записи
3. **Компилирует C# wrapper** (`BrowserMcpService.cs` → `service/BrowserMcp.Service.exe`)
4. **Регистрирует Windows-службу** `BrowserMcp` (autostart, restart-on-failure)
5. **Настраивает файрвол** — порт 9229 только для указанной подсети
6. **Запускает checklist** — 19 автоматических проверок безопасности

## Управление службой

```powershell
# Статус
Get-Service BrowserMcp

# Запуск
Start-Service BrowserMcp

# Остановка
Stop-Service BrowserMcp

# Перезапуск
Restart-Service BrowserMcp

# Просмотр логов
Get-Content "C:\ProgramData\browser-mcp\logs\browser-mcp.log" -Tail 50 -Wait
```

## Обновление

```powershell
# Безопасное обновление: снапшот → сборка → проверка
.\scripts\windows\upgrade.ps1
```

## Откат

```powershell
# Восстановление предыдущей версии
.\scripts\windows\rollback.ps1
```

## Ротация токена

```powershell
# Смена bearer-токена
.\scripts\windows\rotate-token.ps1 -NewToken 'новый_секрет'
```

## Экстренная остановка

```powershell
# Немедленно убить весь доступ
.\scripts\windows\emergency-stop.ps1

# Отмена экстренной остановки
.\scripts\windows\emergency-stop.ps1 -Revert
```

## Проверка безопасности

```powershell
# 19 автоматических проверок
.\scripts\windows\security-checklist.ps1
```

Проверки включают:
- Статус службы
- Конфигурация файрвола
- Права доступа к файлам
- Наличие секретов в небезопасных местах
- Привязка портов

## Полная процедура установки

```powershell
# Шаг 1: Сборка
npm install
npm run build
npm test

# Шаг 2: Установка (от администратора)
.\scripts\windows\install.ps1 `
    -Subnet 192.168.88.0/24 `
    -GatewayToken (New-Guid | Select-Object -ExpandProperty Guid)

# Шаг 3: Проверка
.\scripts\windows\security-checklist.ps1

# Шаг 4: Тестирование
curl http://127.0.0.1:9230/healthz
```

## Конфигурация

Не секретные параметры хранятся в:
```
C:\ProgramData\browser-mcp\service.env
```

Пример:
```env
CDP_ENDPOINT=http://127.0.0.1:9222
GATEWAY_ENABLED=true
GATEWAY_LISTEN_HOST=0.0.0.0
GATEWAY_LISTEN_PORT=9229
MCP_TRANSPORT=streamable-http
MCP_LISTEN_HOST=127.0.0.1
MCP_LISTEN_PORT=9230
BROWSER_ALLOWED_DOMAINS=*
LOG_FILE=C:\ProgramData\browser-mcp\logs\browser-mcp.log
```

## Логи

```powershell
# Текущие логи
Get-Content "C:\ProgramData\browser-mcp\logs\browser-mcp.log" -Tail 100

# Логи PM2 (если используется)
Get-Content "$env:USERPROFILE\.pm2\logs\browser-mcp-out.log" -Tail 50
Get-Content "$env:USERPROFILE\.pm2\logs\browser-mcp-error.log" -Tail 50
```

## Полное удаление

```powershell
.\scripts\windows\uninstall.ps1
```

Удаляет:
- Windows-службу
- Сервисную учётную запись
- Правила файрвола
- Секреты из Credential Manager
- Конфигурацию и логи
