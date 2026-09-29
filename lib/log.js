// Client diagnostics, persisted by the host so a report never has to be
// transcribed from a DevTools console.
//
// The renderer's console is not written anywhere the host can read it, and most
// of what matters for a "the tree did the wrong thing" report happens in the
// renderer — including errors the app's own sidebar logs. The client therefore
// posts its lines back over the same HTTP route as every other action, and the
// host appends them here, under the harness's own storages root (the sidecar's
// directory). One file per day, never rotated by the plugin: the volume is a few
// lines per click, and a long tail beats a clever truncation when you only look
// at a file after something broke.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dshHome } from './tree-state.js';

/** Directory that holds the per-day log files. */
export function logDir(home = dshHome()) {
  return join(home, 'storages', 'tree-view', 'logs');
}

/** The day-scoped file for a given instant. */
export function logPath(now = new Date(), home = dshHome()) {
  const iso = now.toISOString().slice(0, 10);
  return join(logDir(home), `tree-view-${iso}.log`);
}

/**
 * Append one entry to today's file. `entry` is `{ level, message, meta }` as
 * posted by the client; `meta` is serialised as one JSON line for greppability.
 * Synchronous on purpose: the volume is tiny, the host can afford it, and a line
 * that is still in the buffer when the process dies is a line lost.
 */
export function appendLog(entry, now = new Date(), home = dshHome()) {
  const level = typeof entry?.level === 'string' && entry.level ? entry.level : 'info';
  const message = typeof entry?.message === 'string' ? entry.message : String(entry?.message ?? '');
  let meta = '';
  if (entry?.meta !== undefined && entry.meta !== null) {
    try { meta = ' ' + JSON.stringify(entry.meta); } catch (e) { meta = ' [meta not serialisable]'; }
  }
  const line = `${now.toISOString()} [${level}] ${message}${meta}\n`;
  const file = logPath(now, home);
  mkdirSync(logDir(home), { recursive: true });
  appendFileSync(file, line, 'utf8');
}
