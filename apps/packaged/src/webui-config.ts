import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

export type WebuiCommand = "start" | "stop" | "status";

export type WebuiFlags = {
  port?: number;
  daemonPort?: number;
  host?: string;
  token?: string;
  openBrowser?: boolean;
  json?: boolean;
  config?: string;
  /** run attached to the terminal instead of detaching into the background. */
  foreground?: boolean;
  /** launcher output locale override (e.g. "en", "zh-CN"). */
  lang?: string;
};

export type WebuiConfigFile = {
  /** 浏览器访问端口（web 子进程的监听端口）。 */
  port?: number;
  /** daemon 监听端口；省略或 0 表示随机环回端口（仅本机内部使用）。 */
  daemonPort?: number;
  host?: string;
  token?: string;
  openBrowser?: boolean;
  namespace?: string;
  dataDir?: string | null;
  /** launcher output locale (e.g. "en", "zh-CN"). */
  lang?: string;
};

export type ResolvedWebuiConfig = {
  port: number;
  /** null 表示动态环回端口（默认）。 */
  daemonPort: number | null;
  host: string;
  token: string | null;
  openBrowser: boolean;
  namespace: string | null;
  dataDir: string | null;
};

const DEFAULT_PORT = 7456;
// Fixed default daemon port (web + 1) so the internal daemon address is stable
// across restarts instead of a random loopback port. Set daemonPort to 0 to opt
// back into dynamic allocation.
const DEFAULT_DAEMON_PORT = 7457;
const DEFAULT_HOST = "127.0.0.1";
const COMMANDS = new Set<WebuiCommand>(["start", "stop", "status"]);

export function parseWebuiArgs(argv: string[]): { command: WebuiCommand; flags: WebuiFlags } {
  const flags: WebuiFlags = {};
  let command: WebuiCommand = "start";
  let i = 0;

  if (argv.length > 0 && !argv[0].startsWith("-")) {
    const candidate = argv[0];
    if (!COMMANDS.has(candidate as WebuiCommand)) {
      throw new Error(`unknown command: ${candidate} (expected start|stop|status)`);
    }
    command = candidate as WebuiCommand;
    i = 1;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--port":
        flags.port = Number(argv[++i]);
        if (!Number.isInteger(flags.port)) throw new Error("--port must be an integer");
        break;
      case "--daemon-port":
        flags.daemonPort = Number(argv[++i]);
        if (!Number.isInteger(flags.daemonPort)) throw new Error("--daemon-port must be an integer");
        break;
      case "--host":
        flags.host = argv[++i];
        break;
      case "--token":
        flags.token = argv[++i];
        break;
      case "--config":
        flags.config = argv[++i];
        break;
      case "--no-open":
        flags.openBrowser = false;
        break;
      case "--foreground":
        flags.foreground = true;
        break;
      case "--lang":
        flags.lang = argv[++i];
        break;
      case "--json":
        flags.json = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { command, flags };
}

export function loadConfigFile(path: string): WebuiConfigFile | null {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as WebuiConfigFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`failed to read config file ${path}: ${(error as Error).message}`);
  }
}

export function resolveWebuiConfig(input: {
  flags: WebuiFlags;
  configFile: WebuiConfigFile | null;
  env: NodeJS.ProcessEnv;
}): ResolvedWebuiConfig {
  const { flags, configFile, env } = input;
  const cfg = configFile ?? {};

  const envPort = env.OD_WEB_PORT != null ? Number(env.OD_WEB_PORT) : undefined;
  const port =
    flags.port ?? cfg.port ?? (Number.isInteger(envPort) ? (envPort as number) : undefined) ?? DEFAULT_PORT;

  // daemonPort defaults to the fixed DEFAULT_DAEMON_PORT so the internal daemon
  // address is deterministic across restarts. An explicit 0 (flag/config/env)
  // opts back into a random loopback port chosen by the daemon (OD_PORT=0),
  // which resolves to null here.
  const envDaemonPort = env.OD_PORT != null ? Number(env.OD_PORT) : undefined;
  const daemonPortRaw =
    flags.daemonPort ??
    cfg.daemonPort ??
    (Number.isInteger(envDaemonPort) ? (envDaemonPort as number) : undefined) ??
    DEFAULT_DAEMON_PORT;
  const daemonPort = daemonPortRaw > 0 ? daemonPortRaw : null;

  const host = flags.host ?? cfg.host ?? env.OD_BIND_HOST ?? DEFAULT_HOST;
  const token = flags.token ?? cfg.token ?? env.OD_API_TOKEN ?? null;
  const openBrowser = flags.openBrowser ?? cfg.openBrowser ?? true;
  const namespace = cfg.namespace ?? env.OD_PACKAGED_NAMESPACE ?? null;
  const dataDir = cfg.dataDir ?? env.OD_DATA_DIR ?? null;

  return { port, daemonPort, host, token, openBrowser, namespace, dataDir };
}

/**
 * The canonical default `webui.config.json` body, written when first-run
 * scaffolding finds no example to copy. Mirrors the built-in defaults and
 * surfaces BOTH ports so users can see what is configurable: `port` is the
 * browser-facing web port; `daemonPort` 0 documents the dynamic-loopback
 * default (set a real port only to pin/expose the internal daemon API).
 */
export function defaultWebuiConfigFileContents(): string {
  const body = {
    port: DEFAULT_PORT,
    daemonPort: DEFAULT_DAEMON_PORT,
    host: DEFAULT_HOST,
    token: null,
    openBrowser: true,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

// Maps the *bind* host to a host a browser can actually open. A bind-all host
// (0.0.0.0 / ::) is not browsable, so we surface the machine's first
// non-internal LAN IPv4 instead; loopback binds show as "localhost"; a concrete
// host passes through. Interfaces are injectable for tests.
export function resolveDisplayHost(
  host: string,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  const isBindAll = normalized === "0.0.0.0" || normalized === "::" || normalized === "";
  if (isBindAll) {
    for (const addrs of Object.values(interfaces)) {
      for (const addr of addrs ?? []) {
        if (addr.family === "IPv4" && !addr.internal) return addr.address;
      }
    }
    return "localhost";
  }
  return isLoopbackHost(host) ? "localhost" : host;
}

// Persists an auto-generated token back into webui.config.json so the next
// start reuses it instead of minting a new one. Preserves any existing keys.
// Never throws on a read-only install dir — the caller falls back to an
// in-memory token for the current run.
export function persistTokenToConfig(
  configPath: string,
  token: string,
): { persisted: boolean; error?: string } {
  try {
    const existing: WebuiConfigFile = existsSync(configPath)
      ? (JSON.parse(readFileSync(configPath, "utf8")) as WebuiConfigFile)
      : {};
    const next = { ...existing, token };
    writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return { persisted: true };
  } catch (error) {
    return { persisted: false, error: (error as Error).message };
  }
}

/**
 * First-run convenience: materialize `webui.config.json` when it does not yet
 * exist, copying the shipped `webui.config.example.json` verbatim when present
 * and otherwise writing {@link defaultWebuiConfigFileContents}. Returns whether
 * a file was created. Never throws on a read-only install dir — the caller
 * keeps running on resolved defaults and only surfaces a notice.
 */
export function ensureWebuiConfigScaffold(input: {
  configPath: string;
  examplePath: string;
}): { created: boolean; error?: string } {
  if (existsSync(input.configPath)) return { created: false };
  try {
    if (existsSync(input.examplePath)) {
      copyFileSync(input.examplePath, input.configPath);
    } else {
      writeFileSync(input.configPath, defaultWebuiConfigFileContents(), "utf8");
    }
    return { created: true };
  } catch (error) {
    return { created: false, error: (error as Error).message };
  }
}

// Mirrors the daemon's isLoopbackHostname (apps/daemon/src/server.ts): the
// net.isIP guard is required so this launcher's "is loopback → skip token"
// decision can never disagree with the daemon's "non-loopback → require token"
// enforcement. A malformed host like "127.garbage" must be treated as
// non-loopback by BOTH, or the launcher skips token generation while the daemon
// refuses to start without one.
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost") return true;
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (isIP(normalized) === 4) return normalized === "127.0.0.1" || normalized.startsWith("127.");
  return false;
}

export function generateApiToken(): string {
  return `odtoken_${randomBytes(32).toString("base64url")}`;
}

export function hasDisplay(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform === "win32") return true;
  if (platform === "darwin") return env.SSH_CONNECTION == null;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}
