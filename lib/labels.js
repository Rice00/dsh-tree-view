// Per-version labels for the tree view.
//
// Where a label lives is the whole design question, and both obvious answers
// are wrong for our purposes:
//
//   * The host's own session title is the natural home, and it is exactly what
//     we do NOT want to touch. This fork keeps the sidebar title host-owned
//     ("... (2)" and all) and renames only the node drawn in the tree.
//   * The session log is the other natural home, and it is worse. Appending a
//     plugin event to a log is a durability hazard: custom event types live
//     outside the harness vocabulary, and a marker written without the
//     `ignorable` envelope makes the cold-read guard reject the entire session.
//     A rename must never be able to cost someone a conversation.
//
// A sidecar file can only cost a label. It is also trivially inspectable and
// deletable, which matters for anything we add on top of someone else's data.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** A label is UI text on a 176px card, not data: keep it short. */
export const LABEL_MAX_LENGTH = 60;

/**
 * The DSH home, resolved the way the harness resolves it: `$DSH_HOME` when it
 * is set and non-empty, otherwise `~/.dsh`.
 */
export function dshHome(env = process.env, home = homedir()) {
  const fromEnv = env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  return join(home, '.dsh');
}

/** Sidecar path for the label map, under the harness's own storages root. */
export function labelsFilePath(home = dshHome()) {
  return join(home, 'storages', 'tree-view', 'labels.json');
}

/**
 * Read the label map. Anything unreadable — missing file, truncated write, a
 * foreign JSON shape — degrades to "no labels" rather than throwing: a broken
 * sidecar must never take the tree view down with it.
 */
export function readLabels(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const labels = {};
  for (const [sessionId, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value.length > 0) labels[sessionId] = value;
  }
  return labels;
}

/** Write the label map atomically, so a crash cannot leave a half-written file. */
export function writeLabels(file, labels) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(labels, null, 2)}\n`);
  renameSync(temporary, file);
}

/** Trim and bound one label. An empty result is the documented "clear it". */
export function normalizeLabel(value) {
  if (typeof value !== 'string') throw new TypeError('label 必须是字符串。');
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length > LABEL_MAX_LENGTH) {
    throw new TypeError(`label 最多 ${LABEL_MAX_LENGTH} 个字符。`);
  }
  return trimmed;
}

/** Set (or, with an empty label, clear) one version's label. Returns the map. */
export function setLabel(file, sessionId, label) {
  const labels = readLabels(file);
  if (label.length === 0) delete labels[sessionId];
  else labels[sessionId] = label;
  writeLabels(file, labels);
  return labels;
}
