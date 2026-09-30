// Exercise npm's real packaging lifecycle in a temporary output directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = mkdtempSync(join(tmpdir(), 'tree-view-package-'));
try {
  assert.ok(process.env.npm_execpath, 'Run this check through npm run check:package');
  const result = spawnSync(process.execPath, [
    process.env.npm_execpath, 'pack', '--json', '--silent', '--pack-destination', output,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const [pack] = JSON.parse(result.stdout);
  const files = new Map(pack.files.map(file => [file.path, file.size]));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const syntax = spawnSync(process.execPath, ['--check', join(root, pkg.main)], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.error?.message || syntax.stderr);
  const required = new Set([
    pkg.main, 'lib/client.js', 'lib/log.js', 'lib/tree-logic.js', 'lib/session-record.js', 'plugin.client.js',
    'cordis.patch.yml', 'package.json', 'LICENSE', 'NOTICE',
    // The panel icon is read from the installed package, so it has to be in the tarball —
    // and the host refuses anything over 256 KiB, which is why the icon is its own small
    // file rather than the README's logo.
    pkg.icon, 'assets/logo.png', 'assets/screenshot-tree.png', 'assets/screenshot-ring.png',
    ...Object.values(pkg.exports).map(entry => typeof entry === 'string' ? entry : entry.default),
  ]);
  for (const path of required) {
    assert.ok(files.get(path.replace(/^\.\//, '')) > 0, `Missing or empty package file: ${path}`);
  }
  const icon = files.get(pkg.icon.replace(/^\.\//, ''));
  assert.ok(icon <= 256 * 1024, `Icon exceeds the host's 256 KiB limit: ${icon} bytes`);
  assert.match(pkg.icon, /^\.\/[^/].*\.(svg|png|jpg|jpeg|webp)$/,
    'The icon must be a package-relative path to an image the host accepts');
  assert.ok(![...files.keys()].some(path => /^(node_modules|test|\.github|\.git)\//.test(path)),
    'Development files must not ship in the package');
  console.log(`Package verified: ${pack.filename}; ${files.size} files; all runtime entries present.`);
} finally {
  // Only remove the unique temporary directory created by this invocation.
  rmSync(output, { recursive: true, force: true });
}
