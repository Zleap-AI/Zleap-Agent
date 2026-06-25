import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Thin wrapper around the official Feishu CLI (`@larksuite/cli`, binary
 * `lark-cli`). The gateway drives it as a subprocess: a long-lived
 * `event +subscribe` WebSocket stream for inbound messages and one-shot
 * `im +messages-send` for outbound. Credentials are owned by lark-cli itself; we
 * isolate them per channel by pointing `HOME` at a dedicated directory (verified:
 * lark-cli stores config under `$HOME/.lark-cli`).
 *
 * Reference: https://github.com/larksuite/cli
 */

export type LarkBrand = 'feishu' | 'lark';
/** Outbound/identity selector for `auth login` / `im +messages-send`. */
export type LarkIdentity = 'user' | 'bot' | 'auto';

/** Default EventKey for inbound IM messages (overridable). */
export const DEFAULT_EVENT_KEY = 'im.message.receive_v1';
/** Default binary name resolved from PATH when no bundled copy exists. */
export const DEFAULT_CLI_BIN = 'lark-cli';

/**
 * Resolve the lark-cli executable: explicit override → bundled `@larksuite/cli`
 * (project install via pnpm) → bare `lark-cli` on PATH.
 */
export function resolveLarkCliBin(override?: string): string {
  const explicit = override?.trim();
  if (explicit) {
    return explicit;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve('@larksuite/cli/package.json');
    const runJs = join(dirname(pkgJson), 'scripts/run.js');
    if (existsSync(runJs)) {
      return runJs;
    }
  } catch {
    // @larksuite/cli not installed — fall back to PATH lookup.
  }
  return DEFAULT_CLI_BIN;
}

export type LarkCliOptions = {
  /** Binary name or absolute path (FEISHU_CLI_BIN). Defaults to `lark-cli`. */
  bin?: string;
  /** HOME for credential isolation; lark-cli persists under `$HOME/.lark-cli`. */
  home?: string;
  brand?: LarkBrand;
  /** Injectable spawner for tests. Defaults to node:child_process spawn. */
  spawnImpl?: typeof spawn;
};

export type RunResult = { code: number; stdout: string; stderr: string };

export type AuthStatus = { authorized: boolean; account?: string; raw: unknown };
export type ConfigStatus = { configured: boolean; raw: unknown };
export type DeviceLogin = { verificationUrl?: string; deviceCode?: string; raw: unknown };

export type SendInput = {
  chatId?: string;
  userId?: string;
  text: string;
  identity: 'user' | 'bot';
  markdown?: boolean;
  idempotencyKey?: string;
};

export type EventStreamHandlers = {
  onLine: (line: string) => void;
  onError?: (error: Error) => void;
  onClose?: (code: number | null) => void;
};

export type EventStreamHandle = { stop(): void };

const DEFAULT_TIMEOUT_MS = 30_000;

export class LarkCliClient {
  private readonly bin: string;
  private readonly home: string | undefined;
  private readonly brand: LarkBrand;
  private readonly spawnImpl: typeof spawn;

  constructor(options: LarkCliOptions = {}) {
    this.bin = options.bin ?? DEFAULT_CLI_BIN;
    this.home = options.home;
    this.brand = options.brand ?? 'feishu';
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  /** Whether the app credentials are configured (config init done). */
  async configStatus(): Promise<ConfigStatus> {
    const result = await this.run(['config', 'show']);
    const raw = parseJson(result.stdout);
    const configured = isOk(raw) && subtype(raw) !== 'not_configured';
    return { configured, raw };
  }

  /** Whether a user/bot token is present (auth login done). */
  async authStatus(): Promise<AuthStatus> {
    const result = await this.run(['auth', 'status', '--json']);
    const raw = parseJson(result.stdout);
    const authorized = isOk(raw) && result.code === 0;
    return { authorized, account: extractAccount(raw), raw };
  }

  /**
   * Seed the default app config non-interactively (App ID + secret via stdin).
   * No `--name` so it initializes the unnamed default profile that `auth`/`im`
   * commands operate on (a named profile would diverge from the active config).
   */
  async initApp(appId: string, appSecret: string): Promise<RunResult> {
    return this.run(
      ['config', 'init', '--app-id', appId, '--app-secret-stdin', '--brand', this.brand],
      { input: `${appSecret}\n` },
    );
  }

  /**
   * Begin a non-blocking device-flow login. Returns the verification URL (to
   * surface to the user) and a device code (to poll completion with).
   */
  async beginDeviceLogin(identity: LarkIdentity): Promise<DeviceLogin> {
    const args = ['auth', 'login', '--recommend', '--no-wait', '--json'];
    if (identity === 'user' || identity === 'bot') {
      args.push('--as', identity);
    }
    const result = await this.run(args);
    const raw = parseJson(result.stdout);
    return {
      verificationUrl: extractUrl(raw),
      deviceCode: extractDeviceCode(raw),
      raw,
    };
  }

  /** Poll a pending device login to completion. */
  async pollDeviceLogin(deviceCode: string): Promise<AuthStatus> {
    const result = await this.run(['auth', 'login', '--device-code', deviceCode, '--json']);
    const raw = parseJson(result.stdout);
    return { authorized: isOk(raw) && result.code === 0, account: extractAccount(raw), raw };
  }

  /** Send a text (or markdown) message. */
  async sendMessage(input: SendInput): Promise<{ messageId?: string }> {
    const args = ['im', '+messages-send'];
    if (input.chatId) {
      args.push('--chat-id', input.chatId);
    } else if (input.userId) {
      args.push('--user-id', input.userId);
    }
    args.push(input.markdown ? '--markdown' : '--text', input.text);
    args.push('--as', input.identity, '--json');
    if (input.idempotencyKey) {
      args.push('--idempotency-key', input.idempotencyKey);
    }
    const result = await this.run(args);
    if (result.code !== 0) {
      throw new Error(`lark-cli send failed (code ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    const raw = parseJson(result.stdout);
    return { messageId: extractMessageId(raw) };
  }

  /** Clear stored credentials for this channel (logout). */
  async logout(): Promise<RunResult> {
    return this.run(['auth', 'logout']);
  }

  /**
   * Start a long-lived `event +subscribe` subprocess (the official WebSocket
   * event stream) emitting NDJSON (one event per line) to stdout. Identity is
   * bot (App ID/Secret) — no `--as`/user login needed for inbound. The server
   * splits events across connections, so we keep a single instance (no
   * `--force`). Returns a handle whose `stop()` kills the child.
   *
   * Reference: skills/lark-event (lark-cli event +subscribe).
   */
  subscribe(eventKey: string, handlers: EventStreamHandlers): EventStreamHandle {
    const args = ['event', '+subscribe', '--event-types', eventKey, '--quiet'];
    const child = this.spawnImpl(this.bin, args, { env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          handlers.onLine(line);
        }
        index = buffer.indexOf('\n');
      }
    });
    child.on('error', (error) => handlers.onError?.(error));
    child.on('close', (code) => {
      if (buffer.trim()) {
        handlers.onLine(buffer.trim());
        buffer = '';
      }
      handlers.onClose?.(code);
    });
    return {
      stop: () => {
        child.kill('SIGTERM');
      },
    };
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, ...(this.home ? { HOME: this.home } : {}) };
  }

  private run(args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.bin, args, { env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref?.();
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 0, stdout, stderr });
      });
      if (opts.input !== undefined) {
        child.stdin?.end(opts.input);
      } else {
        child.stdin?.end();
      }
    });
  }
}

/** Parse the last JSON object emitted on stdout (CLI prepends an install line). */
function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall back to the last balanced JSON object/array in the output.
    const start = trimmed.search(/[[{]/);
    if (start >= 0) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOk(raw: unknown): boolean {
  // lark-cli wraps success as { ok: true, ... } and errors as { ok: false }.
  if (isRecord(raw) && 'ok' in raw) {
    return raw.ok === true;
  }
  return isRecord(raw);
}

function subtype(raw: unknown): string | undefined {
  if (isRecord(raw) && isRecord(raw.error)) {
    return typeof raw.error.subtype === 'string' ? raw.error.subtype : undefined;
  }
  return undefined;
}

function dataOf(raw: unknown): Record<string, unknown> {
  if (isRecord(raw) && isRecord(raw.data)) {
    return raw.data;
  }
  return isRecord(raw) ? raw : {};
}

function extractUrl(raw: unknown): string | undefined {
  const data = dataOf(raw);
  return firstString(data, ['verification_url', 'verification_uri', 'verification_uri_complete', 'url', 'authorize_url']);
}

function extractDeviceCode(raw: unknown): string | undefined {
  const data = dataOf(raw);
  return firstString(data, ['device_code', 'deviceCode']);
}

function extractAccount(raw: unknown): string | undefined {
  const data = dataOf(raw);
  return firstString(data, ['account', 'name', 'user_id', 'open_id', 'union_id']);
}

function extractMessageId(raw: unknown): string | undefined {
  const data = dataOf(raw);
  return firstString(data, ['message_id', 'messageId', 'msg_id']);
}

function firstString(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
