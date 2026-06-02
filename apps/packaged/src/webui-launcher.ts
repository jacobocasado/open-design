import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  APP_KEYS,
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_DEFAULTS,
  SIDECAR_MESSAGES,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
  normalizeDesktopSidecarMessage,
  type SidecarStamp,
} from "@open-design/sidecar-proto";
import {
  bootstrapSidecarRuntime,
  createJsonIpcServer,
  requestJsonIpc,
  resolveAppIpcPath,
} from "@open-design/sidecar";
import { isProcessAlive, spawnBackgroundProcess } from "@open-design/platform";
import { openBrowser } from "@open-design/daemon/browser-open";

import { PACKAGED_NAMESPACE_ENV, type PackagedConfig } from "./config.js";
import { writePackagedDesktopIdentity, writePackagedWebIdentity } from "./identity.js";
import { resolvePackagedNamespacePaths } from "./paths.js";
import { readSidecarLogTail, startPackagedSidecars } from "./sidecars.js";
import { resolveWebuiLocale, webuiMessages } from "./webui-i18n.js";
import {
  ensureWebuiConfigScaffold,
  generateApiToken,
  hasDisplay,
  isLoopbackHost,
  loadConfigFile,
  parseWebuiArgs,
  persistTokenToConfig,
  resolveDisplayHost,
  resolveWebuiConfig,
  type ResolvedWebuiConfig,
  type WebuiConfigFile,
} from "./webui-config.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// This module's own path, re-executed (with the `__serve` arg) as the detached
// background worker that actually holds the sidecars.
const SELF = fileURLToPath(import.meta.url);
// Internal subcommand for the detached worker — not user-facing.
const SERVE_COMMAND = "__serve";
const RESOLVED_CONFIG_ENV = "OD_WEBUI_RESOLVED";

function resolveNamespaceBaseRoot(): string {
  const odDataDir = process.env.OD_DATA_DIR;
  if (odDataDir != null && odDataDir.length > 0) {
    return join(resolve(odDataDir.replace(/^~/, homedir())), "namespaces");
  }
  const xdgDataHome = process.env.XDG_DATA_HOME;
  const dataBase =
    xdgDataHome != null && xdgDataHome.length > 0 ? xdgDataHome : join(homedir(), ".local", "share");
  return join(dataBase, "open-design", "namespaces");
}

function resolveLauncherConfig(namespace: string): PackagedConfig {
  const resourceRoot =
    process.env.OD_RESOURCE_ROOT ?? join(__dirname, "..", "..", "..", "open-design");
  return {
    amrProfile: null,
    appVersion: null,
    daemonCliEntry: null,
    daemonSidecarEntry: null,
    namespace,
    namespaceBaseRoot: resolveNamespaceBaseRoot(),
    nodeCommand: null,
    resourceRoot,
    telemetryRelayUrl: process.env.OPEN_DESIGN_TELEMETRY_RELAY_URL?.trim() || null,
    posthogKey: process.env.POSTHOG_KEY?.trim() || null,
    posthogHost: process.env.POSTHOG_HOST?.trim() || null,
    webSidecarEntry: null,
    webStandaloneRoot: null,
    // 与现有 Linux headless 一致的、已验证可在打包后运行的 web 运行模式。
    webOutputMode: "server",
  };
}

function createStamp(namespace: string): SidecarStamp {
  return {
    app: APP_KEYS.DESKTOP,
    ipc: resolveAppIpcPath({ app: APP_KEYS.DESKTOP, contract: OPEN_DESIGN_SIDECAR_CONTRACT, namespace }),
    mode: SIDECAR_MODES.RUNTIME,
    namespace,
    source: SIDECAR_SOURCES.PACKAGED,
  };
}

function colorize(text: string): string {
  if (process.stdout.isTTY !== true || process.env.NO_COLOR != null) return text;
  return `\x1b[36m\x1b[4m${text}\x1b[0m`;
}

// The install root that holds the launcher scripts and the shipped
// `webui.config.example.json`. The shell/cmd wrappers export OD_WEBUI_HOME so
// config discovery and first-run scaffolding are stable regardless of the
// caller's cwd; we fall back to cwd when launched directly via `node`.
function resolveWebuiHome(): string {
  const home = process.env.OD_WEBUI_HOME;
  return home != null && home.length > 0 ? resolve(home) : process.cwd();
}

type ConfigDiscovery = {
  configFile: WebuiConfigFile | null;
  configPath: string;
  scaffold: { created: boolean; error?: string };
};

// Resolves the active config file, auto-creating `webui.config.json` on first
// run (copying the shipped example, else writing defaults). An explicit
// `--config <path>` is honored verbatim and never scaffolded. `configPath` is
// returned so an auto-generated token can be persisted back into it; the raw
// scaffold result is returned so the caller can localize the notice.
function discoverConfigFile(explicitPath: string | undefined): ConfigDiscovery {
  if (explicitPath != null) {
    return { configFile: loadConfigFile(explicitPath), configPath: resolve(explicitPath), scaffold: { created: false } };
  }
  const home = resolveWebuiHome();
  const configPath = join(home, "webui.config.json");
  const examplePath = join(home, "webui.config.example.json");
  const scaffold = ensureWebuiConfigScaffold({ configPath, examplePath });
  return { configFile: loadConfigFile(configPath), configPath, scaffold };
}

function browserUrl(config: ResolvedWebuiConfig): string {
  // resolveDisplayHost turns a bind-all host (0.0.0.0) into the machine's real
  // LAN IP so the printed address is actually openable.
  return `http://${resolveDisplayHost(config.host)}:${config.port}`;
}

// The daemon binds `config.host`, so its direct API is reachable at the same
// display host (LAN IP for 0.0.0.0). Prefer the actually bound port from the
// daemon's reported URL; fall back to the configured one.
function daemonDirectUrlFor(config: ResolvedWebuiConfig, daemonSidecarUrl: string | null): string | null {
  const host = resolveDisplayHost(config.host);
  let port: string | null;
  try {
    port = new URL(daemonSidecarUrl ?? "").port || (config.daemonPort != null ? String(config.daemonPort) : null);
  } catch {
    port = config.daemonPort != null ? String(config.daemonPort) : null;
  }
  return port != null ? `http://${host}:${port}` : null;
}

function currentLocale() {
  return resolveWebuiLocale({ env: process.env });
}

// The launcher script users invoke (`stop` / `start --foreground` hints append
// to it). Windows ships open-design.cmd; POSIX ships ./open-design.sh.
function cmdBase(): string {
  return process.platform === "win32" ? "open-design.cmd" : "./open-design.sh";
}

type ServeHandle = { webUrl: string; daemonUrl: string | null };

// Starts daemon+web sidecars, writes identities, and stands up the desktop IPC
// server (STATUS/SHUTDOWN). Shared by the detached background worker and by
// `--foreground` mode. It does NOT print the banner or open a browser — the
// orchestrator owns user-facing output. The process stays alive afterwards via
// the IPC server handle (no explicit blocking needed).
async function runServer(config: ResolvedWebuiConfig): Promise<ServeHandle> {
  const namespace = OPEN_DESIGN_SIDECAR_CONTRACT.normalizeNamespace(
    config.namespace ?? process.env[PACKAGED_NAMESPACE_ENV] ?? SIDECAR_DEFAULTS.namespace,
  );
  if (config.dataDir != null) process.env.OD_DATA_DIR = config.dataDir;

  const packagedConfig = resolveLauncherConfig(namespace);
  const paths = resolvePackagedNamespacePaths(packagedConfig);
  const stamp = createStamp(namespace);
  await mkdir(paths.runtimeRoot, { recursive: true });

  const runtime = bootstrapSidecarRuntime(stamp, process.env, {
    app: APP_KEYS.DESKTOP,
    base: paths.runtimeRoot,
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
  });

  const identity = await writePackagedDesktopIdentity({
    identityPath: paths.headlessIdentityPath,
    paths,
    stamp,
  });

  const sidecars = await startPackagedSidecars(runtime, paths, {
    appVersion: packagedConfig.appVersion,
    amrProfile: packagedConfig.amrProfile,
    daemonCliEntry: packagedConfig.daemonCliEntry,
    daemonSidecarEntry: packagedConfig.daemonSidecarEntry,
    nodeCommand: packagedConfig.nodeCommand,
    telemetryRelayUrl: packagedConfig.telemetryRelayUrl,
    posthogKey: packagedConfig.posthogKey,
    posthogHost: packagedConfig.posthogHost,
    // webui mode: no Electron, no shell.openPath surface; no desktop auth gate.
    requireDesktopAuth: false,
    webSidecarEntry: packagedConfig.webSidecarEntry,
    webStandaloneRoot: packagedConfig.webStandaloneRoot,
    webOutputMode: packagedConfig.webOutputMode,
    network: {
      webHost: config.host,
      webPort: config.port,
      daemonPort: config.daemonPort,
      bindHost: config.host,
      apiToken: config.token,
    },
  });

  const webUrl = sidecars.web.url;
  if (!webUrl) {
    await sidecars.close().catch(() => undefined);
    await identity.close().catch(() => undefined);
    throw new Error("web sidecar failed to produce URL — check logs/web/latest.log");
  }
  const displayUrl = browserUrl(config);
  const daemonUrl = daemonDirectUrlFor(config, sidecars.daemon.url ?? null);
  const t = webuiMessages(currentLocale());

  const shutdown = async (): Promise<void> => {
    process.stdout.write(`\n ${t.shuttingDown}\n`);
    await ipcServer.close().catch(() => undefined);
    await sidecars.close().catch(() => undefined);
    await identity.close().catch(() => undefined);
    process.exit(0);
  };

  const ipcServer = await createJsonIpcServer({
    socketPath: stamp.ipc,
    handler: async (message: unknown) => {
      const request = normalizeDesktopSidecarMessage(message);
      switch (request.type) {
        case SIDECAR_MESSAGES.STATUS:
          return { pid: process.pid, state: "running", url: displayUrl, daemonUrl, updatedAt: new Date().toISOString() };
        case SIDECAR_MESSAGES.SHUTDOWN:
          setImmediate(() => {
            void shutdown().finally(() => process.exit(0));
          });
          return { accepted: true };
      }
    },
  });

  await writePackagedWebIdentity({ paths, pid: process.pid, url: displayUrl });

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  return { webUrl: displayUrl, daemonUrl };
}

function printStartBanner(opts: {
  json: boolean;
  handle: ServeHandle;
  config: ResolvedWebuiConfig;
  token: string | null;
  tokenNotice: string | null;
  tokenPersisted: boolean | null;
  background: boolean;
}): void {
  const { webUrl, daemonUrl } = opts.handle;
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({
        pid: process.pid,
        url: webUrl,
        webPort: opts.config.port,
        daemonUrl,
        token: opts.token,
        background: opts.background,
        tokenPersisted: opts.tokenPersisted,
      })}\n`,
    );
    return;
  }
  const t = webuiMessages(currentLocale());
  process.stdout.write(`\n ${t.started}\n\n`);
  process.stdout.write(` ➜ ${t.accessAt} ${colorize(webUrl)}\n\n`);
  // Point 4: one address — /api is reverse-proxied, browser needs no token.
  process.stdout.write(` • ${t.apiSameAddress}\n`);
  if (daemonUrl != null) {
    process.stdout.write(` • ${opts.token != null ? t.daemonDirect(daemonUrl) : t.daemonInternal(daemonUrl)}\n`);
  }
  if (opts.token != null) {
    process.stdout.write(` • ${t.tokenLine(opts.token)}\n`);
    if (opts.tokenNotice != null) process.stdout.write(`   ${opts.tokenNotice}\n`);
  }
  if (opts.background) {
    const cmd = cmdBase();
    process.stdout.write(`\n ${t.runningInBackground}\n`);
    process.stdout.write(` ${t.hintStop(cmd)}\n`);
    process.stdout.write(` ${t.hintForeground(cmd)}\n\n`);
  } else {
    process.stdout.write(`\n ${t.pressCtrlC}\n\n`);
  }
}

// Polls the worker's desktop IPC STATUS until it reports a URL, fast-failing if
// the detached worker dies (reads its log tail into the error so the real
// failure surfaces in the foreground terminal).
async function waitForWebuiReady(
  ipcPath: string,
  pid: number,
  timeoutMs: number,
  logPath: string,
): Promise<ServeHandle> {
  const start = Date.now();
  const t = webuiMessages(currentLocale());
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) {
      const tail = await readSidecarLogTail(logPath);
      throw new Error(`${t.startFailedLog(logPath)}${tail.length > 0 ? `:\n${tail}` : ""}`);
    }
    try {
      const reply = (await requestJsonIpc(ipcPath, { type: SIDECAR_MESSAGES.STATUS }, { timeoutMs: 800 })) as {
        url?: string;
        daemonUrl?: string | null;
      };
      if (reply?.url != null && reply.url.length > 0) {
        return { webUrl: reply.url, daemonUrl: reply.daemonUrl ?? null };
      }
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  const tail = await readSidecarLogTail(logPath);
  throw new Error(`${t.startFailedLog(logPath)}${tail.length > 0 ? `:\n${tail}` : ""}`);
}

// The detached background worker: re-resolves the config the foreground passed
// via env, holds the sidecars + IPC server, and stays alive. Its stdout/stderr
// are redirected to the namespace log file by spawnBackgroundProcess.
async function commandServe(): Promise<void> {
  const raw = process.env[RESOLVED_CONFIG_ENV];
  if (raw == null || raw.length === 0) {
    throw new Error(`${RESOLVED_CONFIG_ENV} missing for ${SERVE_COMMAND} worker`);
  }
  const config = JSON.parse(raw) as ResolvedWebuiConfig;
  await runServer(config);
}

async function commandStart(
  config: ResolvedWebuiConfig,
  json: boolean,
  configPath: string,
  foreground: boolean,
): Promise<void> {
  const t = webuiMessages(currentLocale());

  // Apply dataDir before computing namespace paths so the foreground (log path)
  // and the detached worker (which inherits this env) agree on the data root.
  if (config.dataDir != null) process.env.OD_DATA_DIR = config.dataDir;

  let token = config.token;
  let tokenNotice: string | null = null;
  let tokenPersisted: boolean | null = null;
  if (!isLoopbackHost(config.host) && (token == null || token.length === 0)) {
    // First remote start with no token: mint one and persist it to the config
    // file so subsequent restarts reuse it (no fresh token, no repeated notice).
    token = generateApiToken();
    const persisted = persistTokenToConfig(configPath, token);
    tokenPersisted = persisted.persisted;
    tokenNotice = persisted.persisted ? t.tokenPersisted(configPath) : t.tokenPersistFailed(persisted.error ?? "");
  }
  const resolved: ResolvedWebuiConfig = { ...config, token };

  if (foreground) {
    // Attached mode (systemd/docker/debug): run the server inline and block via
    // the IPC server. Ctrl+C triggers the shutdown handler installed in runServer.
    const handle = await runServer(resolved);
    printStartBanner({ json, handle, config: resolved, token, tokenNotice, tokenPersisted, background: false });
    if (resolved.openBrowser && hasDisplay(process.platform, process.env)) openBrowser(handle.webUrl);
    return;
  }

  // Default: detach into the background. Spawn this module again as `__serve`,
  // unref it, wait for readiness over IPC, print, then exit so the terminal is
  // free. `stop` talks to the detached worker over the same IPC path.
  const namespace = OPEN_DESIGN_SIDECAR_CONTRACT.normalizeNamespace(
    resolved.namespace ?? process.env[PACKAGED_NAMESPACE_ENV] ?? SIDECAR_DEFAULTS.namespace,
  );
  const paths = resolvePackagedNamespacePaths(resolveLauncherConfig(namespace));
  await mkdir(paths.logsRoot, { recursive: true });
  const logPath = join(paths.logsRoot, "webui.log");
  const logHandle = await open(logPath, "a");
  const ipcPath = resolveAppIpcPath({ app: APP_KEYS.DESKTOP, contract: OPEN_DESIGN_SIDECAR_CONTRACT, namespace });

  let pid: number;
  try {
    const spawned = await spawnBackgroundProcess({
      command: process.execPath,
      args: [SELF, SERVE_COMMAND],
      cwd: process.cwd(),
      env: {
        ...process.env,
        [RESOLVED_CONFIG_ENV]: JSON.stringify(resolved),
        OD_LANG: currentLocale(),
      },
      logFd: logHandle.fd,
    });
    pid = spawned.pid;
  } finally {
    await logHandle.close().catch(() => undefined);
  }

  const handle = await waitForWebuiReady(ipcPath, pid, 60_000, logPath);
  printStartBanner({ json, handle, config: resolved, token, tokenNotice, tokenPersisted, background: true });
  if (resolved.openBrowser && hasDisplay(process.platform, process.env)) openBrowser(handle.webUrl);
  process.exit(0);
}

async function commandStopOrStatus(command: "stop" | "status", json: boolean): Promise<void> {
  const namespace = OPEN_DESIGN_SIDECAR_CONTRACT.normalizeNamespace(
    process.env[PACKAGED_NAMESPACE_ENV] ?? SIDECAR_DEFAULTS.namespace,
  );
  const ipc = resolveAppIpcPath({ app: APP_KEYS.DESKTOP, contract: OPEN_DESIGN_SIDECAR_CONTRACT, namespace });
  const type = command === "stop" ? SIDECAR_MESSAGES.SHUTDOWN : SIDECAR_MESSAGES.STATUS;
  const t = webuiMessages(currentLocale());
  try {
    const reply = await requestJsonIpc(ipc, { type }, { timeoutMs: 2000 });
    if (json) process.stdout.write(`${JSON.stringify(reply)}\n`);
    else if (command === "status") process.stdout.write(` ${JSON.stringify(reply)}\n`);
    else process.stdout.write(` ${t.stopped}\n`);
  } catch {
    if (json) process.stdout.write(`${JSON.stringify({ state: "stopped" })}\n`);
    else process.stdout.write(` ${t.notRunning(namespace)}\n`);
    if (command === "status") process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Internal: the detached background worker re-enters here.
  if (argv[0] === SERVE_COMMAND) {
    await commandServe();
    return;
  }
  const { command, flags } = parseWebuiArgs(argv);
  if (command === "start") {
    const json = flags.json === true;
    const { configFile, configPath, scaffold } = discoverConfigFile(flags.config);
    // Resolve locale from --lang > config.lang > env, then pin it via OD_LANG so
    // all downstream output (and the detached worker) share one language.
    const locale = resolveWebuiLocale({ flagLang: flags.lang, configLang: configFile?.lang, env: process.env });
    process.env.OD_LANG = locale;
    const t = webuiMessages(locale);
    if (!json) {
      if (scaffold.created) process.stdout.write(`\n ${t.configCreated(configPath)}\n`);
      else if (scaffold.error != null) process.stdout.write(`\n ${t.configCreateFailed(scaffold.error)}\n`);
    }
    const config = resolveWebuiConfig({ flags, configFile, env: process.env });
    await commandStart(config, json, configPath, flags.foreground === true);
    return;
  }
  const locale = resolveWebuiLocale({ flagLang: flags.lang, env: process.env });
  process.env.OD_LANG = locale;
  await commandStopOrStatus(command, flags.json === true);
}

void main().catch((error: unknown) => {
  process.stderr.write(`open-design webui failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
