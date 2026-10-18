/**
 * Test helper: launches a disposable Chrome instance with remote debugging
 * enabled on a private temp profile. Used by the Stage 4 integration tests.
 *
 * The system Chrome is located via HB_TEST_CHROME_PATH or well-known paths;
 * tests skip themselves when no executable is found. The helper never touches
 * the user's real profile.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface TestChrome {
  readonly endpoint: string;
  readonly port: number;
  readonly pid: number;
  readonly process: ChildProcess;
  /** Kills the whole Chrome process tree and removes the temp profile. */
  close(): Promise<void>;
}

export function findChromeExecutable(): string | undefined {
  const override = process.env.HB_TEST_CHROME_PATH;
  if (override && fs.existsSync(override)) return override;

  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA ?? '';
    if (localAppData)
      candidates.push(path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'));
    candidates.push(path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'));
    candidates.push(path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      for (const dir of ['/usr/bin', '/usr/local/bin', '/snap/bin']) {
        candidates.push(path.join(dir, name));
      }
    }
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function cdpGet(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: urlPath }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

export async function cdpIsAlive(port: number): Promise<boolean> {
  try {
    const response = await cdpGet(port, '/json/version');
    return response.status === 200;
  } catch {
    return false;
  }
}

async function waitForCdp(child: ChildProcess, port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`test Chrome exited early with code ${child.exitCode} (${lastError})`);
    }
    if (await cdpIsAlive(port)) return;
    lastError = 'CDP endpoint not answering yet';
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`test Chrome CDP endpoint did not come up within ${timeoutMs} ms`);
}

function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const done = (): void => resolve();
    child.once('exit', done);
    if (process.platform === 'win32') {
      const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      taskkill.on('error', () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      });
    } else {
      const pid = child.pid;
      try {
        // Detached spawn: kill the whole process group.
        if (pid !== undefined) process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    // Never hang the test suite on a stuck browser.
    setTimeout(() => {
      child.off('exit', done);
      resolve();
    }, 5_000).unref();
  });
}

async function removeProfile(profileDir: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.promises.rm(profileDir, { recursive: true, force: true });
      return;
    } catch {
      // Windows keeps files locked briefly after the process tree dies.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export interface StartTestChromeOptions {
  /** Reuse a specific port (needed for restart tests); default: a free port. */
  readonly port?: number;
  readonly headless?: boolean;
}

export async function startTestChrome(options: StartTestChromeOptions = {}): Promise<TestChrome> {
  const executable = findChromeExecutable();
  if (!executable) throw new Error('No Chrome executable found');

  const port = options.port ?? (await findFreePort());
  const profileDir = await fs.promises.mkdtemp(path.join(tmpdir(), 'browser-mcp-test-chrome-'));
  const headless = options.headless ?? process.env.HB_TEST_CHROME_HEADFUL !== '1';

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-dev-shm-usage',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  if (process.env.HB_TEST_CHROME_NO_SANDBOX === '1') args.unshift('--no-sandbox');

  const child = spawn(executable, args, {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  try {
    await waitForCdp(child, port);
  } catch (error) {
    await killTree(child);
    await removeProfile(profileDir);
    throw error;
  }

  return {
    endpoint: `http://127.0.0.1:${port}`,
    port,
    pid: child.pid ?? 0,
    process: child,
    close: async () => {
      await killTree(child);
      await removeProfile(profileDir);
    },
  };
}
