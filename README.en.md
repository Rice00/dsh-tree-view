<div align="center">

<img src="assets/logo.png" alt="dsh-tree-view" width="150" />

# dsh-tree-view

**One conversation = one tree = one sidebar entry**

Use a conversation as a tree view in DeepSeek Harness: edit an old message and the conversation forks from that turn — **every fork lives in one tree**, and the sidebar never grows a second entry.

[![License: MIT](https://img.shields.io/badge/License-MIT-2f7de1.svg)](./LICENSE)
[![Platform: DSH web](https://img.shields.io/badge/platform-DSH%20web-334eac.svg)](#compatibility)
[![DSH: 0.1.5-rc.2](https://img.shields.io/badge/dsh-0.1.5--rc.2-4b8dff.svg)](#compatibility)
[![PRs: welcome](https://img.shields.io/badge/PRs-welcome-7096d1.svg)](#contributing)
[![GitHub stars](https://img.shields.io/github/stars/Rice00/dsh-tree-view?style=flat&label=stars&color=7096d1)](https://github.com/Rice00/dsh-tree-view/stargazers)

[Features](#features) · [Install](#install) · [Quick start](#quick-start) · [Settings](#settings) · [How it works](#how-it-works) · [**中文**](./README.md)

</div>

---

## Features

| | |
|---|---|
| 🌳 **One tree holds the whole family** | The **Tree** tab draws versions as a turn-level branch graph: the shared opening collapses into one trunk, each fork opens into a branch. |
| 🎯 **The line you read is highlighted** | Where I came from, where I am, where I can still go — off one picture. |
| 📌 **The sidebar never grows a second entry** | Whichever version holds the sidebar slot follows the line you read; the slot count never grows, and it is always reversible. |
| ✋ **Your sessions are never collected behind your back** | Editing, retrying, opening a session from the sidebar, restoring where you last read — none of them touches an archived flag. Only picking a version from the tree moves the slot. |
| 🗂️ **Long stretches fold themselves** | A run of turns that offers no choice folds into a stack of offset sheets whose colour follows state; the threshold is counted per stretch, so a short one is never folded because a long one sits next to it. |
| 👁️ **What you need stays visible** | The start of the conversation, fork points, the end of a line, and the turn you are generating right now never fold away. |
| 🤖 **Subagent conversations are labelled** | A subagent hangs its session under your conversation, which the tree would otherwise draw as a version of your message; those cards carry a subagent tag so they read as what they are. |
| ♻️ **Collect and put back, always reversible** | Both just flip the archived state: no session is created, copied, or deleted. |
| ⚙️ **Every switch in one place** | Settings → **TreeView**, five items, each described in the panel and previewed live. |
| 🔒 **A view, not a rewrite** | Drawing the tree, swapping the slot and folding are all client-side behaviour; not one byte of the session log changes. |
| 🧩 **Coexists with upstream** | Row id `tree-view`, route `/tree-view`; the durable event type stays upstream's `message-tree/version`, so sessions already branched there read as trees here. |
| 🎨 **Follows the DSH theme** | Surface, border, accent, state and even shadow colours come from tokens the host actually defines: light follows light, dark follows dark, with no hardcoded dark value left. |

## Install

```bash
dsh plugin --profile web add github:Rice00/dsh-tree-view
```

Then **restart that profile** — host plugin modules are cached in-process, so a running harness will not pick the new row up. UI-only changes just need a page refresh.

To get changes live, point at a local checkout instead — `link:` is a live link, so edits to the source take effect immediately:

```bash
dsh plugin --profile web add link:<absolute-path-to-repo>
```

<details>
<summary><b>Let an AI assistant do it (copy-paste)</b></summary>

```
Please install the DSH plugin dsh-tree-view for me:

1) Install it into the web profile, from GitHub:
     dsh plugin --profile web add github:Rice00/dsh-tree-view
   or from a local checkout (absolute path of the folder):
     dsh plugin --profile web add link:<absolute-path>
2) Restart that profile. Host plugin modules are cached in-process, so the new row is
   only picked up on boot. (UI-only changes just need a browser refresh.)
3) Verify: a TreeView section appears in Settings; a Tree tab appears in the conversation panel.
   The startup log should carry a tree-view line.
```

</details>

## Quick start

1. **Edit a message you already sent** — the conversation forks from that turn, the way ChatGPT and Claude do it, instead of continuing from the end.
2. **See the whole family** — the **Tree** tab in the conversation panel: pan, zoom with the wheel, click a node to jump.
3. **Collect or put back** — right-click any node; both actions only flip its archived state.

## Settings

Everything lives under **Settings → TreeView**:

| Setting | Default | Effect |
| --- | --- | --- |
| Message control style | DeepSeek | ChatGPT / DeepSeek / Claude button layouts, previewed live in the panel |
| Open the version I was last reading | off | Coming back to this family from elsewhere resumes the version you last read |
| Stop the reply that is still being written | on | Stop a running reply in the same family before editing / retrying, saving quota |
| Hide forks with no new turns | on | Forks that only copied this conversation without adding turns are not drawn |
| Fold long straight stretches | 8 turns and up | Never / 5 / 8 / 12 / 20 |

## How it works

A DSH session is an append-only event log with no notion of an in-session branch, so rewind is implemented here:

1. **Seed a new session** — when you edit, the host creates a new session seeded with "every event before the target turn", writes a durable `message-tree/version` marker describing the edit, then sends the edited prompt into it. That is a real rewind, not a continuation from the end.
2. **Read the markers back to rebuild the tree** — the client turns those markers into the tree, the version counter, and the line you are currently on.
3. **`ignorable` is mandatory** — the plugin's custom event type is not in the host's event vocabulary; without that envelope flag the reader refuses to interpret the whole log and the session will not open at all.

The host-side branching engine comes from [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) (MIT © Moeblack); this fork rebuilds it around ChatGPT-style rewind semantics.

---

<details>
<summary><b>It never fails silently</b></summary>

Archiving and unarchiving go through `ctx.workspaceRegistry`: archiving uses the supported `archiveSession`, while unarchiving has to write its state directly (**this dsh version has no unarchive API**). That coupling sits in one file, `lib/archive-adapter.js`, probed once at startup:

- If a host upgrade drops a piece, the plugin **does not pretend otherwise**: the startup log carries `archive support is incomplete … missing: …`, the panel says so at the top, the collect / put-back buttons and menu items grey out with the reason, and the rest of the tree view keeps working.
- If the archive set cannot be read, the plugin **does not guess**: it would rather do nothing than claim "no session is hidden".

</details>

<details>
<summary><b>Development and tests</b></summary>

```bash
npm run build   # bundle the client half plugin.client.js into lib/client.js
npm test        # verify the bundle is current, then run every test
```

The tests are **behavioural**: the client half is mounted in jsdom through its real slot registrations and driven by real DOM events, asserting card attributes, POST payloads and navigation calls rather than internals. Currently **14 test files / 122 cases**, all green when run here.

```
lib/index.js            host half: branching engine, archive adapter, HTTP endpoints
plugin.client.js        client half (source)
lib/client.js           client half (bundle, built by scripts/build-client.mjs)
lib/archive-adapter.js  host archive capability probe
test/                   behavioural tests
docs/                   architecture / tree data model / development
```

</details>

## Uninstall

```bash
dsh plugin --profile web remove dsh-tree-view
```

No session is deleted.

## Docs

- [Architecture](docs/ARCHITECTURE.md) — host / client split, Cordis service injection, durable events and HTTP endpoints.
- [Tree data model and algorithms](docs/TREE_DATA_MODEL.md) — turn-level tree building, sibling expansion, ghost bridging, highlighted path, long-stretch folding, main-chat swap.
- [Development](docs/DEVELOPMENT.md) — build pipeline, tests, local install.

## Compatibility

| | |
|---|---|
| **DSH** | verified against `0.1.5-rc.2`; `engines.dsh` declares `>=0.1.5-rc.2 <0.1.6-0`. Restart DSH after updating the plugin. |
| **Profile** | any profile that carries the web UI (`web`; `desktop` works when the same row is added there) |
| **Language** | the UI follows the display language of DSH |
| **Dependencies** | none of its own at runtime |

## Contributing

Issues and pull requests are welcome. Run `npm test` before opening a PR.

## License

[MIT](./LICENSE) © Rice00 (dsh-tree-view)

This repository is a fork of [dsh-plugin-message-edit](https://github.com/SpookySandwich/dsh-plugin-message-edit) (MIT © SpookySandwich), whose host-side branching logic comes from [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) (MIT © Moeblack). Both original copyright notices are kept in `LICENSE` as MIT requires.
