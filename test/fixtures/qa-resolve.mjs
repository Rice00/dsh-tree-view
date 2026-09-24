// Resolve a package that belongs to the installed official runtime, whatever layout npm chose
// for it. npm reshapes that tree whenever a floating dependency changes its peers: on
// 2026-09-22 @deepseek-ai/cordis-plugin-include@1.0.9 demanded a newer @deepseek-ai/cordis than
// @deepseek-ai/dsh-llm pins, and npm answered by nesting the family under @deepseek-ai/dsh — so
// the runtime root stopped holding @deepseek-ai/dsh-llm and the fixture could not import it.
// The anchors are the places the host itself resolves from (so the copy matches its identity);
// the scan is the fallback for whatever else npm buried.
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const ANCHORS = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
const SKIP = new Set(['.bin', 'dist', 'lib', 'src', 'types']);
const MAX_DEPTH = 6;

function nodeModulesRoots(root) {
  const roots = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === 'node_modules') roots.push(path);
      if (entry.name.startsWith('.') || SKIP.has(entry.name) || depth >= MAX_DEPTH) continue;
      walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return roots;
}

export function createQaResolver(modulesRoot) {
  const attempts = [{ label: modulesRoot, dir: modulesRoot }];
  const root = createRequire(join(modulesRoot, 'package.json'));
  for (const anchor of ANCHORS) {
    try {
      const nested = createRequire(root.resolve(`${anchor}/package.json`));
      attempts.push({ label: anchor, dir: undefined, resolve: spec => nested.resolve(spec) });
    } catch {
      // This package is not part of the tree; the remaining anchors still count.
    }
  }
  const resolveFrom = attempt => attempt.resolve
    ?? (attempt.resolve = spec => createRequire(join(attempt.dir, 'package.json')).resolve(spec));
  let scanned;
  const scanAnchors = () => {
    scanned ??= nodeModulesRoots(modulesRoot)
      .filter(dir => !attempts.some(attempt => attempt.dir === dir))
      .map(dir => ({ label: dir, dir }));
    return scanned;
  };
  return spec => {
    const failures = [];
    for (const attempt of [...attempts, ...scanAnchors()]) {
      try {
        return resolveFrom(attempt)(spec);
      } catch (error) {
        failures.push(`${attempt.label}: ${error.code ?? error.message}`);
      }
    }
    const shown = failures.slice(0, 6);
    throw new Error(`Cannot resolve ${spec} in the official runtime; tried ${failures.length} anchors\n`
      + shown.map(line => `  - ${line}`).join('\n')
      + (failures.length > shown.length ? `\n  - ...and ${failures.length - shown.length} more` : ''));
  };
}
