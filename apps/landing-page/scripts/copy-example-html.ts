/**
 * Post-build copier — `skills/<slug>/example.html` and
 * `design-templates/<slug>/example.html` get copied next to the
 * static detail-page output (`out/skills/<slug>/example.html`,
 * `out/templates/live-<slug>/preview.html` for live-artifacts) so the
 * detail-page iframe and "Open in new tab" links resolve.
 *
 * Why post-build copy and not Astro endpoint routes:
 *   Astro 6 does not register `pages/<dir>/[slug]/<file>.<ext>.ts`
 *   files as static endpoints under dynamic segments — the route is
 *   silently dropped at build time and the iframe URL 404s on deploy
 *   even with `export const prerender = true`. A flat copy step at the
 *   end of `astro build` sidesteps the routing mismatch entirely.
 *
 * Without this step the build artifact only contains the per-detail
 * `index.html` Astro generates from `[slug]/index.astro`. Cloudflare
 * Pages then SPA-fallbacks `/skills/<slug>/example.html` to the
 * homepage, which the browser displays as "404 / wrong page" inside
 * the iframe.
 *
 * Live-artifact templates carry a `live-` slug prefix
 * (`shapeLiveArtifactTemplate()` in `_lib/catalog.ts`); their detail
 * page sits at `/templates/live-<slug>/`, so the preview must land at
 * `out/templates/live-<slug>/preview.html`. The source file is
 * `index.html` (the rendered preview), not `template.html` (which
 * still contains `{{data.*}}` placeholders).
 *
 * Runs after `astro build`. Read source from the repo-root content
 * directories (`skills/`, `design-templates/`, `templates/`) — same
 * convention `generate-previews.ts` already uses.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const OUT_DIR = path.join(APP_ROOT, 'out');
const SKILLS_SRC = path.join(REPO_ROOT, 'skills');
const DESIGN_TEMPLATES_SRC = path.join(REPO_ROOT, 'design-templates');
const LIVE_ARTIFACTS_SRC = path.join(REPO_ROOT, 'templates', 'live-artifacts');
const BUNDLED_PLUGINS_SRC = path.join(REPO_ROOT, 'plugins', '_official');
// Buckets that may carry a runnable `example.html` referenced by the
// manifest's `od.preview.entry`. `design-systems`, `image-templates`,
// `video-templates`, `scenarios` ship media (poster URL or generated
// card) instead and don't need an iframe-able local entry.
const BUNDLED_BUCKETS_WITH_EXAMPLE = ['examples'] as const;

let copied = 0;
let skipped = 0;
let assetDirsCopied = 0;

function copyIfExists(srcFile: string, destFile: string): boolean {
  if (!existsSync(srcFile)) return false;
  mkdirSync(path.dirname(destFile), { recursive: true });
  copyFileSync(srcFile, destFile);
  return true;
}

// Some example.html / index.html files are thin shells that iframe a
// neighbouring `./assets/<file>` (template HTML, fonts, mp4 showcase,
// etc.). Without copying that sibling directory the iframe path 404s on
// Cloudflare Pages and SPA-fallbacks to the homepage, so the user sees
// the OD landing instead of the skill preview.
//
// Only mirror `assets/` when the entrypoint actually references it via
// a relative `./assets/...` URL — most skills carry an `assets/` folder
// of reference imagery (PNG mocks, design notes) that the demo never
// loads, and shipping those would inflate the deploy by tens of MB.
function copyReferencedAssetsDir(
  entrypointHtml: string,
  srcSlugDir: string,
  destSlugDir: string,
): boolean {
  if (!existsSync(entrypointHtml)) return false;
  const html = readFileSync(entrypointHtml, 'utf8');
  if (!/\b(?:src|href|poster)\s*=\s*["']\.\/assets\//i.test(html)) return false;
  const assetsSrc = path.join(srcSlugDir, 'assets');
  if (!existsSync(assetsSrc) || !statSync(assetsSrc).isDirectory()) return false;
  cpSync(assetsSrc, path.join(destSlugDir, 'assets'), { recursive: true });
  return true;
}

function listDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => {
    const full = path.join(root, name);
    return statSync(full).isDirectory() && !name.startsWith('_') && !name.startsWith('.');
  });
}

// 1. Skills — `skills/<slug>/example.html` → `out/skills/<slug>/example.html`.
for (const slug of listDirs(SKILLS_SRC)) {
  const srcDir = path.join(SKILLS_SRC, slug);
  const destDir = path.join(OUT_DIR, 'skills', slug);
  const entrypointSrc = path.join(srcDir, 'example.html');
  const ok = copyIfExists(entrypointSrc, path.join(destDir, 'example.html'));
  if (ok) {
    copied++;
    if (copyReferencedAssetsDir(entrypointSrc, srcDir, destDir)) assetDirsCopied++;
  } else {
    skipped++;
  }
}

// 2. Design templates — `design-templates/<slug>/example.html` →
//    `out/skills/<slug>/example.html`. The landing-page detail layer
//    treats design templates as a flavor of skill template (see
//    `_lib/catalog.ts` and `pages/templates/[slug]/index.astro` which
//    routes skill-template-origin records to `/skills/<slug>/example.html`).
for (const slug of listDirs(DESIGN_TEMPLATES_SRC)) {
  const srcDir = path.join(DESIGN_TEMPLATES_SRC, slug);
  const destDir = path.join(OUT_DIR, 'skills', slug);
  const entrypointSrc = path.join(srcDir, 'example.html');
  const ok = copyIfExists(entrypointSrc, path.join(destDir, 'example.html'));
  if (ok) {
    copied++;
    if (copyReferencedAssetsDir(entrypointSrc, srcDir, destDir)) assetDirsCopied++;
  }
}

// 3. Live-artifact templates — `templates/live-artifacts/<slug>/index.html`
//    → `out/templates/live-<slug>/preview.html`. The detail-page slug
//    is `live-${rawSlug}` (catalog.ts `shapeLiveArtifactTemplate()`)
//    and the iframe targets `/templates/live-<slug>/preview.html`. We
//    serve `index.html` (the rendered preview) rather than
//    `template.html` (raw template with `{{data.*}}` placeholders).
for (const slug of listDirs(LIVE_ARTIFACTS_SRC)) {
  const srcDir = path.join(LIVE_ARTIFACTS_SRC, slug);
  const destDir = path.join(OUT_DIR, 'templates', `live-${slug}`);
  const entrypointSrc = path.join(srcDir, 'index.html');
  const ok = copyIfExists(entrypointSrc, path.join(destDir, 'preview.html'));
  if (ok) {
    copied++;
    if (copyReferencedAssetsDir(entrypointSrc, srcDir, destDir)) assetDirsCopied++;
  }
}

// 4. Bundled plugins — `plugins/_official/<bucket>/<slug>/<entry>` →
//    `out/plugins/<manifest-id>/<entry>`. Detail pages live at
//    `/plugins/<manifest-id>/`, so the iframe and "Open in new tab"
//    pill point at `/plugins/<manifest-id>/example.html`. The
//    `<bucket>/<slug>` folder name doesn't show up in the URL — it's
//    the manifest's `name` field that does, which we read from
//    `open-design.json` here.
//
// We deliberately walk only `examples/` for now: that's the bucket
// whose manifests carry a local `od.preview.entry`. The other
// bundled-plugin buckets (image/video templates, scenarios,
// design-systems) ship a remote poster URL or a generated fallback
// card and never need a local iframe target.
for (const bucket of BUNDLED_BUCKETS_WITH_EXAMPLE) {
  const bucketDir = path.join(BUNDLED_PLUGINS_SRC, bucket);
  if (!existsSync(bucketDir)) continue;
  for (const slug of listDirs(bucketDir)) {
    const slugDir = path.join(bucketDir, slug);
    const manifestPath = path.join(slugDir, 'open-design.json');
    if (!existsSync(manifestPath)) continue;

    let manifest: { name?: unknown; od?: { preview?: { entry?: unknown } } };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    const manifestId = typeof manifest.name === 'string' ? manifest.name : null;
    const entryRel =
      typeof manifest.od?.preview?.entry === 'string'
        ? manifest.od.preview.entry
        : null;
    if (!manifestId || !entryRel) continue;

    const entrySrc = path.resolve(slugDir, entryRel);
    if (!existsSync(entrySrc)) continue;
    const entryRelClean = entryRel.replace(/^\.\//, '');
    const destDir = path.join(OUT_DIR, 'plugins', manifestId);
    const ok = copyIfExists(entrySrc, path.join(destDir, entryRelClean));
    if (ok) {
      copied++;
      if (copyReferencedAssetsDir(entrySrc, slugDir, destDir)) assetDirsCopied++;
    }
  }
}

console.log(
  `[copy-example-html] copied ${copied} files (+ ${assetDirsCopied} assets/ dirs), skipped ${skipped} (no preview source in repo)`,
);
