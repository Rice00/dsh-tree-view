import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLog, logPath } from '../lib/log.js';

// The writer lives under the harness's storages root; these tests point it at a
// throwaway directory so nothing is written into the real ~/.dsh.

test('appendLog writes one timestamped line to a day-scoped file', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tree-view-log-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const now = new Date('2026-09-29T12:34:56.789Z');
  appendLog({ level: 'warn', message: 'could not open session-x', meta: { id: 'session-x' } }, now, home);

  const file = logPath(now, home);
  assert.ok(existsSync(file), 'the day-scoped file exists: ' + file);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.startsWith('2026-09-29T12:34:56.789Z'), 'the ISO timestamp leads the line: ' + text);
  assert.ok(text.includes(' [warn] '), 'the level is written');
  assert.ok(text.includes('could not open session-x'), 'the message is written');
  assert.ok(text.includes('{"id":"session-x"}'), 'the meta is serialised on one line: ' + text);
});

test('appendLog tolerates an empty entry and defaults the level', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tree-view-log-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const now = new Date('2026-09-29T00:00:00.000Z');
  appendLog({}, now, home);
  const text = readFileSync(logPath(now, home), 'utf8');
  assert.ok(text.includes(' [info] '), 'an entry without a level defaults to info: ' + text);
});
