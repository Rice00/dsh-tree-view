<p align="center">
  <img src="assets/logo.png" alt="dsh-tree-view" width="180">
</p>

<h1 align="center">dsh-tree-view</h1>

<p align="center"><b>Use a conversation as a tree view</b></p>

<p align="center">Edit a message and the conversation forks from that turn. Every fork stays in one tree, and the sidebar keeps one entry.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-tree-view"><img src="https://img.shields.io/npm/v/dsh-tree-view?color=cb3837&logo=npm" alt="npm"></a>
  <a href="https://github.com/Rice00/dsh-tree-view/actions/workflows/ci.yml"><img src="https://github.com/Rice00/dsh-tree-view/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license"></a>
  <img src="https://img.shields.io/badge/dsh-0.1.5--rc.2-4b8dff" alt="dsh">
</p>

<p align="center">English | <a href="README.md">简体中文</a></p>

## A conversation wants to be a tree

A DSH session is an append-only event log. Editing a past message on top of it leaves exactly one honest option: **restart from before that turn**, so one topic grows several versions — the same way it works in ChatGPT and Claude.

Forking is not the problem. The problem is that forks have nowhere to live. By default every version is a sibling session in the sidebar: titles trailing `(1)`, `(2)`, `(3)`, and who came from whom, which edit produced what, and where you are reading now all live in your head. The more you branch, the longer the sidebar gets.

dsh-tree-view keeps the family a different way:

> **One conversation = one tree = one sidebar entry.**

Versions are drawn as a tree, and the shape of that tree is the history of the conversation. The sidebar keeps a single entry, held by whichever version you are reading.

## What makes it different

### The tree is the shape of the conversation

The **Tree** tab draws the whole family as a turn-level branch graph: the shared opening collapses into one trunk, and each fork opens into a branch. The line you are reading is highlighted end to end, so "where I came from, where I am, where I can still go" reads off one picture.

### The sidebar never grows a second entry

This is not "one more button for switching versions" — it is that **whichever version holds the sidebar slot follows the line you read**. Put an older version back into the main chat, and the one you were reading moves into the tree instead: the slot count never grows, and it is always reversible.

And **nothing but picking a version from the tree moves that slot**. Editing, retrying, opening a session from the sidebar, restoring where you last read — each of those can land you on another version, yet none of them changes a single archived flag. Otherwise one casual rewording would quietly collect the session you were in.

### Big families stay readable

As a family grows, the space is eaten by stretches that offer no choice at all: the opening every branch shares, or a line running straight down for turn after turn. Once such a stretch reaches the configured length it folds into a single node, drawn as a stack of offset sheets whose colour follows state — accent while you are on that line, neutral grey when you are not.

The threshold is **counted per stretch**, so a short one is never folded just because a long one sits next to it; the start of the conversation, fork points, the end of a line, and **the turn you are currently generating** never fold away. Folding is reversible at any time.

### Collect and put back, always reversible

Any version can be "collected into the Tree" or "put back into the main chat". Both simply flip its archived state: no session is created, copied, or deleted.

### Subagent conversations are marked

A subagent hangs its session under your conversation, in the same working directory — close enough for the family tree to draw it as if it were a branch of your message (one real conversation had four of them). It is not a version of what you wrote, so its cards carry a small "subagent" tag on the top edge.

### It follows your DSH theme

Every colour comes from the host's own theme variables — surfaces, borders, accent, state colours, even the shadows. Light follows light, dark follows dark, and no dark literal is left in the plugin. A test guards the rule that broke this before: a token name the host does not define is a bug, and that is why the cards used to stay dark on a light theme.

## Install

```bash
dsh plugin --profile web add dsh-tree-view
```

Restart DSH afterwards (the host half loads with the server). The UI follows the display language of DSH.

During development, install the local directory to get changes live:

```bash
dsh plugin --profile web add file:<path-to-repo>
```

## Settings

Everything lives under **Settings → TreeView**, with per-item descriptions in the panel:

| Setting | Default | Effect |
| --- | --- | --- |
| Message control style | DeepSeek | ChatGPT / DeepSeek / Claude button layouts, previewed live in the panel |
| Open the version I was last reading | off | Coming back to this family from elsewhere resumes the version you last read |
| Stop the reply that is still being written | on | Stop a running reply in the same family before editing / retrying, saving quota |
| Hide forks with no new turns | on | Forks that only copied this conversation without adding turns are not drawn |
| Fold long straight stretches | 8 turns and up | Never / 5 / 8 / 12 / 20 |

## How it works

DSH's log has no notion of an in-session branch, so rewind is implemented here. Three steps:

1. **Seed a new session** — when you edit, the host creates a new session seeded with "every event before the target turn", writes a durable `message-tree/version` marker describing the edit, then sends the edited prompt into it. That is a real rewind, not a continuation from the end.
2. **Read the markers back to rebuild the tree** — the client turns those markers into the tree, the version counter, and the line you are currently on.
3. **`ignorable` is mandatory** — the plugin's custom event type is not in the host's event vocabulary; without that envelope flag the reader refuses to interpret the whole log and the session will not open at all.

Drawing the tree, swapping the sidebar slot, and folding are **all client-side view behaviour** and change no data.

The host-side branching engine comes from [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) (MIT © Moeblack); this fork rebuilds it around ChatGPT-style rewind semantics and the rules above.

**Identity**: the cordis row id is `tree-view` and the route is `/tree-view`, separate from upstream's `message-tree`, so both plugins can coexist. The durable event type intentionally stays `message-tree/version` — sessions already branched by upstream still read as trees here, with no data migration.

## It never fails silently

Archiving and unarchiving go through `ctx.workspaceRegistry`: archiving uses the supported `archiveSession`, while unarchiving has to write its state directly (**this dsh version has no unarchive API**). That coupling sits in one file, `lib/archive-adapter.js`, probed once at startup:

- If a host upgrade drops a piece, the plugin **does not pretend otherwise**: the startup log carries `archive support is incomplete … missing: …`, the panel says so at the top, the "collect / put back" buttons and menu items grey out with the reason, and the rest of the tree view keeps working.
- If the archive set cannot be read, the plugin **does not guess**: it would rather do nothing than claim "no session is hidden".

## Development and tests

```bash
npm run build   # bundle the client half plugin.client.js into lib/client.js
npm test        # verify the bundle is current, then run every test
```

The tests are **behavioural**: the client half is mounted in jsdom through its real slot registrations and driven by real DOM events, asserting card attributes, POST payloads and navigation calls rather than internals. Currently **13 files / 118 assertions**, covering tree building, folding and swap rules, toolbar and confirm dialog, the settings panel, memory and restore, image rendering, registration and degradation, the archive adapter, and host compatibility.

## Docs

- [Architecture](docs/ARCHITECTURE.md) — host / client split, Cordis service injection, durable events and HTTP endpoints.
- [Tree data model and algorithms](docs/TREE_DATA_MODEL.md) — turn-level tree building, sibling expansion, ghost bridging, highlighted path, long-stretch folding, main-chat swap.
- [Development](docs/DEVELOPMENT.md) — build pipeline, tests, local install.

## Compatibility and licence

- Verified against dsh **`0.1.5-rc.2`**; `engines.dsh` declares `>=0.1.5-rc.2 <0.1.6-0`. DSH moves fast, so unverified versions are out of scope; restart DSH after updating the plugin.
- MIT © Rice00 (dsh-tree-view). This repository is a fork of [dsh-plugin-message-edit](https://github.com/SpookySandwich/dsh-plugin-message-edit) (MIT © SpookySandwich), whose host-side branching logic comes from [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) (MIT © Moeblack). Both original copyright notices are kept in `LICENSE` as MIT requires.
