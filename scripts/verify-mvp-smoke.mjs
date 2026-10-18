/**
 * Stage 10: MVP live smoke against the BUILT server (dist/src/main.js).
 *
 * Proves on this machine, end to end:
 *   1. the server connects to the configured private CDP endpoint
 *      (a disposable Chrome started for this script);
 *   2. an MCP client (the same exchange ChatGPT/Inspector performs) sees all
 *      15 tools over Streamable HTTP;
 *   3. a site can be opened, clicked and text-extracted through the tools;
 *   7. the MCP endpoint listens on loopback only.
 *
 * Usage: node scripts/verify-mvp-smoke.mjs
 * Env overrides: HB_TEST_CHROME_PATH, HB_MVP_SMOKE_HEADLESS=1 (also disables
 * visible-mode enforcement for the server child).
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_JS = path.join(projectRoot, 'dist', 'src', 'main.js');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '[ ok ]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function findChrome() {
  const override = process.env.HB_TEST_CHROME_PATH;
  if (override && fs.existsSync(override)) return override;
  const candidates = [];
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA ?? '';
    if (localAppData) candidates.push(path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'));
    candidates.push(path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'));
    candidates.push(path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'));
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium');
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function httpGet(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await httpGet(`http://127.0.0.1:${port}/healthz`);
      if (response.status === 200 && response.body.includes('"ok"')) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } catch {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  }
}

/** Windows: prove the listener is bound to loopback, not 0.0.0.0. */
function listeningOnLoopbackOnly(port) {
  if (process.platform !== 'win32') return { checked: false };
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
  const lines = out
    .split(/\r?\n/)
    .filter((line) => line.includes('LISTENING') && line.includes(`:${port} `));
  if (lines.length === 0) return { checked: true, ok: false, detail: 'no LISTENING line found' };
  const bad = lines.filter((line) => !line.trim().startsWith('TCP    127.0.0.1:'));
  return {
    checked: true,
    ok: bad.length === 0,
    detail: lines.map((line) => line.trim()).join(' | '),
  };
}

const SMOKE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>MVP smoke</title></head>
<body>
<h1>MVP smoke fixture</h1>
<button id="go">Reveal</button>
<p id="out" hidden>SMOKE-CLICK-OK</p>
<script>document.getElementById('go').addEventListener('click', function () {
  document.getElementById('out').hidden = false;
});</script>
</body>
</html>`;

async function main() {
  if (!fs.existsSync(MAIN_JS)) {
    console.error('dist/src/main.js not found — run `npm run build` first.');
    process.exit(1);
  }
  const chromeExe = findChrome();
  if (!chromeExe) {
    console.error('No Chrome executable found (set HB_TEST_CHROME_PATH).');
    process.exit(1);
  }

  const headless = process.env.HB_MVP_SMOKE_HEADLESS === '1';
  const chromePort = await findFreePort();
  const fixturePort = await findFreePort();
  const mcpPort = await findFreePort();
  const profileDir = await fs.promises.mkdtemp(path.join(tmpdir(), 'browser-mcp-mvp-smoke-'));

  // Local one-page site: click reveals the text we extract.
  const fixture = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(SMOKE_PAGE);
  });
  await new Promise((resolve) => fixture.listen(fixturePort, '127.0.0.1', resolve));

  const chromeArgs = [
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-extensions',
    'about:blank',
  ];
  if (headless) chromeArgs.unshift('--headless=new');
  const chrome = spawn(chromeExe, chromeArgs, { stdio: 'ignore', windowsHide: true });

  const serverEnv = {
    ...process.env,
    CDP_ENDPOINT: `http://127.0.0.1:${chromePort}`,
    GATEWAY_ENABLED: 'false',
    BROWSER_ALLOWED_DOMAINS: '127.0.0.1',
    MCP_TRANSPORT: 'streamable-http',
    MCP_LISTEN_HOST: '127.0.0.1',
    MCP_LISTEN_PORT: String(mcpPort),
    ...(headless ? { BROWSER_VISIBLE_MODE_REQUIRED: 'false' } : {}),
  };
  let server;
  const serverLog = [];

  const cleanup = () => {
    if (server) killTree(server);
    killTree(chrome);
    try { fixture.close(); } catch { /* ignore */ }
    // Synchronous (the exit hook cannot await): retry briefly because Windows
    // keeps profile files locked for a moment after the Chrome tree dies.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        const waitUntil = Date.now() + 250;
        while (Date.now() < waitUntil) { /* busy wait, bounded */ }
      }
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  try {
    // Wait for Chrome CDP.
    let chromeUp = false;
    for (let i = 0; i < 100; i += 1) {
      if (chrome.exitCode !== null) throw new Error(`Chrome exited early (${chrome.exitCode})`);
      try {
        const response = await httpGet(`http://127.0.0.1:${chromePort}/json/version`);
        if (response.status === 200) { chromeUp = true; break; }
      } catch { /* not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!chromeUp) throw new Error('Chrome CDP endpoint did not come up');

    // Start the BUILT server pointed at the private CDP endpoint.
    server = spawn(process.execPath, [MAIN_JS], {
      env: serverEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    server.stderr.on('data', (chunk) => {
      serverLog.push(chunk.toString('utf8'));
      if (serverLog.length > 200) serverLog.shift();
    });

    const healthy = await waitForHealth(mcpPort);
    record('built server healthy on loopback /healthz', healthy);
    if (!healthy) throw new Error('MCP server did not become healthy');

    const loopback = listeningOnLoopbackOnly(mcpPort);
    if (loopback.checked) {
      record('MCP endpoint listens on 127.0.0.1 only (not published)', loopback.ok, loopback.detail);
    } else {
      record('MCP endpoint bind check', true, 'skipped (non-Windows host)');
    }

    // The same MCP exchange ChatGPT performs: initialize + tools/list + calls.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    const client = new Client({ name: 'mvp-smoke', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`)));

    const { tools } = await client.listTools();
    record('ChatGPT-visible tool surface', tools.length === 15, `${tools.length} tools via tools/list`);

    const connect = await client.callTool({ name: 'browser_connect', arguments: {} });
    const connected = connect.structuredContent?.connected === true;
    record(
      'server connects to the configured private CDP endpoint',
      connected,
      connected ? `endpoint ${connect.structuredContent.endpoint}` : String(connect.content?.[0]?.text ?? ''),
    );
    if (!connected) throw new Error('browser_connect failed');

    const opened = await client.callTool({
      name: 'page_open',
      arguments: { url: `http://127.0.0.1:${fixturePort}/` },
    });
    const pageId = opened.structuredContent?.pageId;
    record('open site', typeof pageId === 'string', `pageId=${pageId}`);
    if (!pageId) throw new Error('page_open failed');

    const clicked = await client.callTool({
      name: 'page_click',
      arguments: { pageId, locator: { kind: 'role', role: 'button', name: 'Reveal' } },
    });
    record('click element', clicked.isError !== true, String(clicked.content?.[0]?.text ?? ''));

    const extracted = await client.callTool({
      name: 'page_extract',
      arguments: { pageId, locator: { kind: 'css', selector: '#out' } },
    });
    const items = extracted.structuredContent?.items ?? [];
    record(
      'extract text',
      items.includes('SMOKE-CLICK-OK'),
      `items=${JSON.stringify(items)}`,
    );

    await client.close();
  } catch (error) {
    record('smoke aborted', false, error instanceof Error ? error.message : String(error));
    if (serverLog.length > 0) {
      console.error('--- last server log lines ---');
      console.error(serverLog.slice(-10).join(''));
    }
  }

  cleanup();
  const failed = results.filter((entry) => !entry.ok).length;
  console.log(failed === 0 ? '\nMVP SMOKE: PASS' : `\nMVP SMOKE: FAIL (${failed} check(s))`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
