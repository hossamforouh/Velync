#!/usr/bin/env node
/**
 * Production build for dashboard/public.
 *
 * The project has no build step by design — dashboard/public is the source
 * of truth developers edit directly, and `npm run dev` / local previews serve
 * it as-is, unminified. This script only runs before a hosting deploy: it
 * copies dashboard/public into dashboard/dist, minifying every .js file
 * along the way (esbuild, syntax-only — no bundling, no behavior change),
 * and leaves every other file (html, css, images, json) untouched.
 *
 * dashboard/dist is a generated artifact (gitignored) — never edit it
 * directly; edits belong in dashboard/public and get picked up on the next
 * build.
 *
 * Usage: node scripts/build-dashboard.js
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const SRC_DIR = path.join(__dirname, '..', 'dashboard', 'public');
const DIST_DIR = path.join(__dirname, '..', 'dashboard', 'dist');

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(walk(full));
    else files.push(full);
  }
  return files;
}

async function build() {
  console.log(`Building ${SRC_DIR} -> ${DIST_DIR}`);

  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const files = walk(SRC_DIR);
  let jsCount = 0, copyCount = 0;

  for (const srcPath of files) {
    const rel = path.relative(SRC_DIR, srcPath);
    const destPath = path.join(DIST_DIR, rel);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    if (srcPath.endsWith('.js')) {
      const source = fs.readFileSync(srcPath, 'utf8');
      const result = await esbuild.transform(source, {
        minify: true,
        // Keep it a straightforward syntax-level minify (no bundling/tree-shaking
        // across files) so relative imports and dynamic import() paths between
        // dashboard/public/js/*.js files keep working unchanged.
        loader: 'js',
        format: 'esm',
        target: 'es2020',
      });
      fs.writeFileSync(destPath, result.code);
      jsCount++;
    } else {
      fs.copyFileSync(srcPath, destPath);
      copyCount++;
    }
  }

  console.log(`Done — minified ${jsCount} .js file(s), copied ${copyCount} other file(s).`);
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
