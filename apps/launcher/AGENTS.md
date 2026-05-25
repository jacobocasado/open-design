# apps/launcher

Follow the root `AGENTS.md` and `apps/AGENTS.md` first. This app owns the native stable launcher experiment.

## Owns

- Cold-start launcher config discovery through `launcher.json`.
- Payload-agnostic cold-start flow: resolve config, build a process spec, spawn the payload, then exit.
- `runtime.json` activation descriptor validation and launcher-owned process plan generation.
- Minimal launcher-owned `attempt.json` crash-loop guard for active generation fallback.
- Native stable-entry process startup primitives that are independent of the product runtime being launched.
- Build-time Windows executable resource metadata, including the launcher icon.

## Does not own

- Electron desktop runtime behavior.
- Daemon/web sidecar startup internals.
- Product updater UI.
- Release feed selection or artifact download logic.
- Downloaded resource cleanup, release rollback policy, or installer handoff.
- Installer registry writes or NSIS script behavior.

## Rules

- Keep the launcher payload-agnostic. A payload is described by a manifest and an entry command; the launcher must not special-case Electron, daemon, web, or Open Design business protocols.
- Keep platform-specific OS primitives in `crates/launcher-platform`.
- Keep cross-platform launcher business flow in `crates/launcher-lifecycle`.
- Keep protocol-shaped app/namespace/endpoint/stamp primitives in `crates/launcher-proto`; this crate is hand-written Rust and does not import TypeScript packages.
- Keep launcher-local resource/update DTOs in `crates/launcher-core`.
- `launcher.json` lookup order is `--root <dir>` > `OD_LAUNCHER_ROOT` > current working directory > launcher executable directory. Explicit root/env misses must fail instead of falling back.
- Prefer `launcher.json` + external `runtime.json` for new activation flows. The `payloadRoot` + `entry` path is only a transitional cold-start path.
- `lastSuccessful` is advanced by desktop after health confirmation; launcher must not treat spawn success as product health.
- Windows launcher builds must embed an `.ico` through the `OD_LAUNCHER_WIN_ICON` build input, defaulting to `tools/pack/resources/win/icon.ico`.

## Common commands

```bash
cargo fmt --manifest-path apps/launcher/Cargo.toml --check
cargo test --manifest-path apps/launcher/Cargo.toml --workspace
cargo build --manifest-path apps/launcher/Cargo.toml --release
cargo run --manifest-path apps/launcher/Cargo.toml -- config print --json --root /path/to/launcher-root
cargo run --manifest-path apps/launcher/Cargo.toml -- runtime plan --json --root /path/to/launcher-root
```
