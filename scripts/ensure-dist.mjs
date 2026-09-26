#!/usr/bin/env node
/**
 * Ensure dist/ is populated before anything reads it.
 *
 * dist/ is a build artefact directory and is not persisted between sessions,
 * so a fresh checkout — or a fresh sandbox — has no index.html and no
 * generated SEO pages. Tests that read dist/ would then fail with a confusing
 * "file does not exist" instead of telling you to build.
 *
 * Imported for its side effect by the dist and SEO test files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const needed = [
  path.join(root, 'dist', 'index.html'),
  path.join(root, 'dist', 'sitemap.xml'),
  path.join(root, 'dist', '_redirects'),
];

if (needed.some((f) => !fs.existsSync(f))) {
  process.stderr.write('ensure-dist: dist/ is incomplete — running npm run build\n');
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
}
