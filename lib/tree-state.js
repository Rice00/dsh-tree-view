// Per-version state for the tree view: the name a branch carries, and whether
// the tree itself put that version away from the main conversation.
//
// Where this state lives is the whole design question, and both obvious answers
// are wrong for our purposes:
//
//   * The host's own session title is the natural home for a name, and it is
//     exactly what we do NOT want to touch. This fork keeps the sidebar title
//     host-owned ("... (2)" and all) and names only the box drawn in the tree.
//   * The session log is the other natural home, and it is worse. Appending a
//     plugin event to a log is a durability hazard: custom event types live
//     outside the harness vocabulary, and a marker written without the
//     `ignorable` envelope makes the cold-read guard reject the entire session.
//     Renaming a branch must never be able to cost someone a conversation.
//
// A sidecar file can only cost a label or a membership flag. It is also
// trivially inspectable and deletable, which matters for anything we add on top
// of someone else's data.
//
// `demoted` records the versions THIS plugin hid from the main conversation.
// It exists because archiving is shared: dsh-sidenote archives its side-chat
// forks too, and the tree has to tell "put away by us, still part of the tree"
// from "someone else's hidden session, not a branch at all".
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** A name is UI text on a node group, not data: keep it short. */
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

/** Sidecar path for the version state map, under the harness's own storages root. */
export function stateFilePath(home = dshHome()) {
  return join(home, 'storages', 'tree-view', 'state.json');
}

/** Where the first release kept names, before membership flags joined them. */
export function legacyLabelsPath(file) {
  return join(dirname(file), 'labels.json');
}

function plainMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Read the state. Anything unreadable — missing file, truncated write, a
 * foreign JSON shape — degrades to "no names, no memberships" rather than
 * throwing: a broken sidecar must never take the tree view down with it.
 */
export function readState(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    // One-way migration from the release that only stored names.
    try {
      const legacy = JSON.parse(readFileSync(legacyLabelsPath(file), 'utf8'));
      return normalizeState({ labels: legacy });
    } catch (legacyError) {
      return { labels: {}, demoted: {} };
    }
  }
  return normalizeState(parsed);
}

function normalizeState(parsed) {
  const raw = plainMap(parsed);
  const labels = {};
  for (const [sessionId, value] of Object.entries(plainMap(raw.labels))) {
    if (typeof value === 'string' && value.length > 0) labels[sessionId] = value;
  }
  const demoted = {};
  for (const [sessionId, value] of Object.entries(plainMap(raw.demoted))) {
    if (value === true) demoted[sessionId] = true;
  }
  return { labels, demoted };
}

/** Write the state atomically, so a crash cannot leave a half-written file. */
export function writeState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, labels: state.labels, demoted: state.demoted }, null, 2)}\n`);
  renameSync(temporary, file);
}

/** Trim and bound one name. An empty result is the documented "clear it". */
export function normalizeLabel(value) {
  if (typeof value !== 'string') throw new TypeError('label 必须是字符串。');
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length > LABEL_MAX_LENGTH) {
    throw new TypeError(`label 最多 ${LABEL_MAX_LENGTH} 个字符。`);
  }
  return trimmed;
}

/** Name (or, with an empty label, unname) one version. Returns the state. */
export function setLabel(file, sessionId, label) {
  const state = readState(file);
  if (label.length === 0) delete state.labels[sessionId];
  else state.labels[sessionId] = label;
  writeState(file, state);
  return state;
}

/** Remember that the tree, not someone else, hid this version. */
export function setDemoted(file, sessionId, demoted) {
  const state = readState(file);
  if (demoted) state.demoted[sessionId] = true;
  else delete state.demoted[sessionId];
  writeState(file, state);
  return state;
}
