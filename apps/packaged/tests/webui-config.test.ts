import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  defaultWebuiConfigFileContents,
  ensureWebuiConfigScaffold,
  generateApiToken,
  hasDisplay,
  isLoopbackHost,
  loadConfigFile,
  parseWebuiArgs,
  persistTokenToConfig,
  resolveDisplayHost,
  resolveWebuiConfig,
} from "../src/webui-config.js";

describe("parseWebuiArgs", () => {
  it("parses command + flags", () => {
    const parsed = parseWebuiArgs([
      "start",
      "--port",
      "8080",
      "--host",
      "0.0.0.0",
      "--token",
      "abc",
      "--no-open",
      "--json",
      "--config",
      "/tmp/c.json",
    ]);
    expect(parsed.command).toBe("start");
    expect(parsed.flags).toEqual({
      port: 8080,
      host: "0.0.0.0",
      token: "abc",
      openBrowser: false,
      json: true,
      config: "/tmp/c.json",
    });
  });

  it("parses --daemon-port as an integer", () => {
    const parsed = parseWebuiArgs(["start", "--daemon-port", "42573"]);
    expect(parsed.flags.daemonPort).toBe(42573);
  });

  it("parses --foreground and --lang", () => {
    const parsed = parseWebuiArgs(["start", "--foreground", "--lang", "zh-CN"]);
    expect(parsed.flags.foreground).toBe(true);
    expect(parsed.flags.lang).toBe("zh-CN");
  });

  it("rejects a non-integer --daemon-port", () => {
    expect(() => parseWebuiArgs(["--daemon-port", "abc"])).toThrow(/--daemon-port must be an integer/);
  });

  it("defaults command to start and leaves unset flags undefined", () => {
    const parsed = parseWebuiArgs([]);
    expect(parsed.command).toBe("start");
    expect(parsed.flags.port).toBeUndefined();
    expect(parsed.flags.host).toBeUndefined();
  });

  it("rejects an unknown command", () => {
    expect(() => parseWebuiArgs(["frobnicate"])).toThrow(/unknown command/i);
  });
});

describe("resolveWebuiConfig precedence", () => {
  it("flag > config file > env > default", () => {
    const resolved = resolveWebuiConfig({
      flags: { port: 8080 },
      configFile: { port: 9090, host: "0.0.0.0", token: "cfgtok" },
      env: { OD_WEB_PORT: "5000", OD_BIND_HOST: "127.0.0.1", OD_API_TOKEN: "envtok" },
    });
    expect(resolved.port).toBe(8080);
    expect(resolved.host).toBe("0.0.0.0");
    expect(resolved.token).toBe("cfgtok");
  });

  it("falls back to env then default", () => {
    const resolved = resolveWebuiConfig({
      flags: {},
      configFile: null,
      env: { OD_WEB_PORT: "5000" },
    });
    expect(resolved.port).toBe(5000);
    expect(resolved.host).toBe("127.0.0.1");
    expect(resolved.port).toBeTypeOf("number");
  });

  it("uses default port 7456 and host 127.0.0.1 when nothing set", () => {
    const resolved = resolveWebuiConfig({ flags: {}, configFile: null, env: {} });
    expect(resolved.port).toBe(7456);
    expect(resolved.host).toBe("127.0.0.1");
    expect(resolved.openBrowser).toBe(true);
  });

  it("defaults daemonPort to the fixed 7457 when unset (deterministic across restarts)", () => {
    const resolved = resolveWebuiConfig({ flags: {}, configFile: null, env: {} });
    expect(resolved.daemonPort).toBe(7457);
  });

  it("treats an explicit daemonPort of 0 as dynamic (null)", () => {
    expect(resolveWebuiConfig({ flags: { daemonPort: 0 }, configFile: null, env: {} }).daemonPort).toBeNull();
    expect(resolveWebuiConfig({ flags: {}, configFile: { daemonPort: 0 }, env: {} }).daemonPort).toBeNull();
  });

  it("resolves daemonPort with flag > config > env precedence", () => {
    expect(
      resolveWebuiConfig({ flags: { daemonPort: 11111 }, configFile: { daemonPort: 22222 }, env: { OD_PORT: "33333" } })
        .daemonPort,
    ).toBe(11111);
    expect(
      resolveWebuiConfig({ flags: {}, configFile: { daemonPort: 22222 }, env: { OD_PORT: "33333" } }).daemonPort,
    ).toBe(22222);
    expect(resolveWebuiConfig({ flags: {}, configFile: null, env: { OD_PORT: "33333" } }).daemonPort).toBe(33333);
  });
});

describe("resolveDisplayHost", () => {
  const ifaces = {
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    eth0: [
      { family: "IPv6", address: "fe80::1", internal: false },
      { family: "IPv4", address: "192.168.1.50", internal: false },
    ],
  } as unknown as ReturnType<typeof import("node:os").networkInterfaces>;

  it("maps bind-all hosts (0.0.0.0 / ::) to the first non-internal LAN IPv4", () => {
    expect(resolveDisplayHost("0.0.0.0", ifaces)).toBe("192.168.1.50");
    expect(resolveDisplayHost("::", ifaces)).toBe("192.168.1.50");
  });

  it("maps loopback hosts to localhost", () => {
    expect(resolveDisplayHost("127.0.0.1", ifaces)).toBe("localhost");
    expect(resolveDisplayHost("localhost", ifaces)).toBe("localhost");
  });

  it("passes a concrete host through unchanged", () => {
    expect(resolveDisplayHost("10.0.0.7", ifaces)).toBe("10.0.0.7");
  });

  it("falls back to localhost when bind-all but no LAN IPv4 is found", () => {
    const loopbackOnly = { lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }] } as unknown as ReturnType<
      typeof import("node:os").networkInterfaces
    >;
    expect(resolveDisplayHost("0.0.0.0", loopbackOnly)).toBe("localhost");
  });
});

describe("persistTokenToConfig", () => {
  it("writes the token while preserving existing keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "od-token-"));
    const configPath = join(dir, "webui.config.json");
    writeFileSync(configPath, JSON.stringify({ port: 7456, host: "0.0.0.0", token: null }), "utf8");

    const result = persistTokenToConfig(configPath, "odtoken_abc");
    expect(result.persisted).toBe(true);
    const written = JSON.parse(loadConfigFileRaw(configPath));
    expect(written.token).toBe("odtoken_abc");
    expect(written.port).toBe(7456);
    expect(written.host).toBe("0.0.0.0");

    rmSync(dir, { force: true, recursive: true });
  });

  it("reports persisted=false on an unwritable path instead of throwing", () => {
    const result = persistTokenToConfig("/proc/nonexistent-dir/webui.config.json", "odtoken_x");
    expect(result.persisted).toBe(false);
    expect(result.error).toBeTypeOf("string");
  });
});

describe("config file scaffolding", () => {
  it("defaultWebuiConfigFileContents is valid JSON exposing both ports", () => {
    const parsed = JSON.parse(defaultWebuiConfigFileContents()) as Record<string, unknown>;
    expect(parsed.port).toBe(7456);
    // Fixed default daemon port keeps restarts deterministic; 0 would mean dynamic.
    expect(parsed.daemonPort).toBe(7457);
    expect(parsed.host).toBe("127.0.0.1");
  });

  it("ensureWebuiConfigScaffold copies the example when present, else writes defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "od-cfg-scaffold-"));
    const configPath = join(dir, "webui.config.json");
    const examplePath = join(dir, "webui.config.example.json");

    // No example, no config → writes defaults and reports created=true.
    const first = ensureWebuiConfigScaffold({ configPath, examplePath });
    expect(first.created).toBe(true);
    expect(JSON.parse(loadConfigFileRaw(configPath)).port).toBe(7456);

    // Config already exists → no-op, created=false.
    const second = ensureWebuiConfigScaffold({ configPath, examplePath });
    expect(second.created).toBe(false);

    rmSync(dir, { force: true, recursive: true });
  });

  it("ensureWebuiConfigScaffold copies the example file verbatim when it exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "od-cfg-copy-"));
    const configPath = join(dir, "webui.config.json");
    const examplePath = join(dir, "webui.config.example.json");
    writeFileSync(examplePath, JSON.stringify({ port: 9999, daemonPort: 8888 }), "utf8");

    const result = ensureWebuiConfigScaffold({ configPath, examplePath });
    expect(result.created).toBe(true);
    const written = JSON.parse(loadConfigFileRaw(configPath));
    expect(written.port).toBe(9999);
    expect(written.daemonPort).toBe(8888);

    rmSync(dir, { force: true, recursive: true });
  });
});

function loadConfigFileRaw(path: string): string {
  return readFileSync(path, "utf8");
}

describe("isLoopbackHost", () => {
  it("treats loopback hosts as local", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });
  it("treats 0.0.0.0 and LAN IPs as remote", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.20")).toBe(false);
  });
  it("treats malformed 127.x hosts as remote (matches daemon net.isIP guard)", () => {
    // Without the IPv4 guard these would be misclassified as loopback, so the
    // launcher would skip token generation while the daemon demands a token.
    expect(isLoopbackHost("127.")).toBe(false);
    expect(isLoopbackHost("127.garbage")).toBe(false);
  });
});

describe("generateApiToken", () => {
  it("produces a prefixed base64url token", () => {
    const token = generateApiToken();
    expect(token).toMatch(/^odtoken_[A-Za-z0-9_-]{20,}$/);
    expect(generateApiToken()).not.toBe(token);
  });
});

describe("loadConfigFile", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "webui-config-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses a valid JSON config file", () => {
    const path = join(dir, "ok.json");
    writeFileSync(path, JSON.stringify({ port: 9090, host: "0.0.0.0" }), "utf8");
    expect(loadConfigFile(path)).toEqual({ port: 9090, host: "0.0.0.0" });
  });

  it("returns null when the file does not exist (ENOENT)", () => {
    expect(loadConfigFile(join(dir, "missing.json"))).toBeNull();
  });

  it("throws on invalid JSON", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ not valid json", "utf8");
    expect(() => loadConfigFile(path)).toThrow(/failed to read config file/i);
  });
});

describe("hasDisplay", () => {
  it("win32 always has display", () => {
    expect(hasDisplay("win32", {})).toBe(true);
  });
  it("darwin has display unless SSH session", () => {
    expect(hasDisplay("darwin", {})).toBe(true);
    expect(hasDisplay("darwin", { SSH_CONNECTION: "x" })).toBe(false);
  });
  it("linux needs DISPLAY or WAYLAND_DISPLAY", () => {
    expect(hasDisplay("linux", {})).toBe(false);
    expect(hasDisplay("linux", { DISPLAY: ":0" })).toBe(true);
    expect(hasDisplay("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
  });
});
