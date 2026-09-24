// The acceptance fixture must find the official runtime's own packages in both layouts npm
// produces: a hoisted tree (everything at the runtime root) and a nested one (the family
// duplicated under the package that asked for it). A wrong answer here aborts the whole
// official-host job before the plugin is even loaded, so both layouts are pinned by test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createQaResolver } from './fixtures/qa-resolve.mjs';

const moduleFile = name => JSON.stringify({ name, version: '1.0.0', main: 'index.js' });

async function runtime(files) {
  const root = await mkdtemp(join(tmpdir(), 'qa-resolve-'));
  const modules = join(root, 'node_modules');
  await mkdir(modules, { recursive: true });
  await writeFile(join(modules, 'package.json'), JSON.stringify({ name: 'qa-runtime', private: true }));
  for (const [path, contents] of Object.entries(files)) {
    const file = join(modules, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  return { root, modules };
}

test('a hoisted runtime resolves from its root', async () => {
  const { root, modules } = await runtime({
    '@deepseek-ai/dsh/package.json': moduleFile('@deepseek-ai/dsh'),
    '@deepseek-ai/dsh-llm/package.json': moduleFile('@deepseek-ai/dsh-llm'),
    '@deepseek-ai/dsh-llm/index.js': 'export const answer = "hoisted";',
  });
  try {
    assert.equal(createQaResolver(modules)('@deepseek-ai/dsh-llm'),
      join(modules, '@deepseek-ai', 'dsh-llm', 'index.js'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a runtime that nests the family resolves inside the package that asked for it', async () => {
  const nested = '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm';
  const { root, modules } = await runtime({
    '@deepseek-ai/dsh/package.json': moduleFile('@deepseek-ai/dsh'),
    [`${nested}/package.json`]: moduleFile('@deepseek-ai/dsh-llm'),
    [`${nested}/index.js`]: 'export const answer = "nested";',
  });
  try {
    assert.equal(createQaResolver(modules)('@deepseek-ai/dsh-llm'), join(modules, nested, 'index.js'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a package nested below the anchored packages is still found', async () => {
  const deep = '@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-attachment-local/node_modules/sharp';
  const { root, modules } = await runtime({
    '@deepseek-ai/dsh/package.json': moduleFile('@deepseek-ai/dsh'),
    '@deepseek-ai/dsh-base/package.json': moduleFile('@deepseek-ai/dsh-base'),
    [`${deep}/package.json`]: moduleFile('sharp'),
    [`${deep}/index.js`]: 'export default "nested sharp";',
  });
  try {
    assert.equal(createQaResolver(modules)('sharp'), join(modules, deep, 'index.js'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a package missing from every layout reports the anchors it tried', async () => {
  const { root, modules } = await runtime({
    '@deepseek-ai/dsh/package.json': moduleFile('@deepseek-ai/dsh'),
  });
  try {
    assert.throws(() => createQaResolver(modules)('@deepseek-ai/dsh-llm'), error => {
      assert.match(error.message, /Cannot resolve @deepseek-ai\/dsh-llm in the official runtime; tried 2 anchors/);
      assert.match(error.message, new RegExp(modules.replace(/\\/g, '\\\\')));
      assert.match(error.message, /@deepseek-ai\/dsh: MODULE_NOT_FOUND/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
