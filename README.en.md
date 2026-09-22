# dsh-tree-view

English | [简体中文](README.md)

[![npm](https://img.shields.io/npm/v/dsh-tree-view?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-tree-view)
[![CI](https://github.com/Rice00/dsh-tree-view/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Rice00/dsh-tree-view/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.1.5--rc.2-4b8dff)](https://github.com/deepseek-ai/deepseek-harness)

> A **fork** of [dsh-plugin-message-edit](https://github.com/SpookySandwich/dsh-plugin-message-edit) (MIT © SpookySandwich): the goal is to turn conversation branching from scattered sessions into **one tree, one sidebar entry**. The upstream branching engine, the tree UI and its test suite are all kept.

Edit a message you already sent and the conversation **rewinds and branches** from that point, the way ChatGPT, Claude and DeepSeek all do it. The old version is not overwritten — a `‹ 2/4 ›` counter appears under the bubble, and the Tree tab draws the whole tree.

## What this fork adds

| Goal | State |
| --- | --- |
| **Rename a branch** from the tree (the sidebar title stays host-owned) | done |
| Right-click **Move to main chat** / **Collect into the tree** | done |
| **Collect every other branch** in one click | done |
| **Hide content-less forks** switch (forks that only copied the conversation) | done |
| **Shared turns merged**: a fork's copied turns are the same nodes as its parent's | done |
| **Capability probe + archive adapter** (degrade loudly, never silently) | done |
| **Long-stretch folding**: the stretch every branch has in common, and any unbranched run a single branch continues on, fold into one node past a threshold and open again when clicked (the toolbar folds and unfolds by hand too; the threshold counts each run on its own) | done |
| **Collect the version you leave** when you switch (off by default, a switch in Settings; a node click, the ‹ › ring and the app moving you all count; the version you open is never collected and one still generating a reply is skipped) | done |
| A truncated "last N turns" view | open |

![demo](https://raw.githubusercontent.com/Rice00/dsh-tree-view/main/assets/demo.gif)

## Version Tree Visualization

No matter how deeply conversations diverge or how many times prompts are edited, the **Tree** tab projects a clear, turn-level branching hierarchy with real-time active path highlights and instant navigation:

![Version Tree](https://raw.githubusercontent.com/Rice00/dsh-tree-view/main/assets/tree-demo.png)

## Living with host versions

Hiding and showing sessions goes through `ctx.workspaceRegistry`: archiving is the supported `archiveSession`, unarchiving has to write the registry's own state (this build exposes **no unarchive API**). That coupling lives in exactly one file, `lib/archive-adapter.js`, which is probed once at load:

- A host upgrade that removes part of the seam is **not silent**: the boot log gets one `archive support is incomplete … missing: …` line, the panel says so in place, and the affected controls (collect, move to main chat) are disabled with the reason on hover. Everything else keeps working.
- A host that cannot read the archive set is **never guessed at**: nothing gets archived on a claim that "nothing is hidden".
- `package.json` still declares the verified range in `engines.dsh` (`>=0.1.5-rc.2 <0.1.6-0`), but the real guard is the probe: a version tells you the host changed, a probe tells you **what** changed.

## What it does

- **Edit and branch.** Revise a past prompt and send: a new branch regenerates from the full context *before* that turn. This is a true rewind, not a fork that continues from the end.
- **Version counter.** When a message has alternatives, `‹ n/m ›` appears beneath it. The arrows move between them instantaneously.
- **Version tree.** A **Versions** tab lays the branches out as a graph you can pan, zoom and drag. The current path is highlighted; click any node to jump to that conversation.
- **Zero-flicker instant switching.** Family-aware SWR client caching enables 0ms version switching and graph navigation without indicator flicker or loading delays.
- **In-memory host caching.** Parsed turns and version metadata are cached in host memory, eliminating redundant disk I/O and JSON parsing for deep branching trees.
- **Automatic cancellation.** Branching immediately cancels any still-streaming obsolete sibling turns across the conversation family to save tokens and compute.
- **Retry.** Re-run a turn without editing it (Claude layout).
- **Copy.** Put the message text on the clipboard.
- **Durable.** Every branch is a real persisted session, and version links are stored as durable events so the tree survives restarts. New branches automatically group into the parent session's workspace.

## Interface style

The three interfaces this imitates differ in **where the controls sit and which ones exist**, so the preset changes exactly that — never the colours, which stay native to DSH. Pick one under **Settings → Message Tree**; the panel previews it live.

| Preset | Controls under the bubble | Shown | Editor buttons |
| --- | --- | --- | --- |
| **ChatGPT** | edit, copy | on hover | `Cancel` / `Send` **inside** the box |
| **DeepSeek** | edit, copy | always — like DSH itself | `Cancel` / `Send` **inside** the box |
| **Claude** | **retry**, edit, copy | on hover | `Cancel` / `Save` **below** the box |

Only Claude offers retry on a user message, matching the real interface. There is no share button, because DSH has none.

## Install

```bash
dsh plugin --profile web add dsh-tree-view
```

Restart DSH afterwards — the host half loads with the server. The interface follows DSH's display language (English / 中文).

## How it works

DSH sessions are append-only event logs with no in-session branching, so a rewind has to be built:

- The host half serves `/tree-view`. Editing a message creates a **new session seeded with every event before the target turn**, writes a durable `message-tree/version` marker naming what changed, and submits the edited prompt.
- Those markers are read back to reconstruct the tree, the `‹ n/m ›` ring, and which branch you are currently on.
- The marker is written with the envelope's `ignorable` flag. Plugin event types live outside the harness vocabulary, and without that flag the reader refuses to interpret the whole log — the session simply fails to open.
- Only the plain `user` message node is shadowed, at priority `-1`. Reasoning, tool calls and steering rows keep the host renderer.

The host-side branching logic derives from [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) (MIT © Moeblack), reworked for ChatGPT-style rewind semantics, sibling fan-out, and the interface presets above.

The names are similar, so to be explicit: this is a separate plugin. Its route, cordis id and durable event type keep a distinct `message-tree` spelling precisely so both can be installed side by side without colliding.

## Documentation

For technical details and developer guides, see:
- [Architecture Overview](docs/ARCHITECTURE.md): Host/client architecture, Cordis lifecycle injection, durable event storage, and HTTP API.
- [Tree Data Model & Algorithms](docs/TREE_DATA_MODEL.md): Turn-level message tree projection, sibling fan-out, ghost recovery, and active path calculation.
- [Development & Testing Guide](docs/DEVELOPMENT.md): Build pipeline, automated test suite, and local installation instructions.

## Compatibility

Version `1.1.0`: Fix seeded edit/retry creation, clear inherited pending input before publication, identify version markers by session ownership, preserve reasoning effort, and read persisted branches through disposable session observations.

The declared host range is `>=0.1.5-rc.2 <0.1.6-0`; the official `0.1.5-rc.2` runtime was verified. DSH `0.1.6` alpha is not claimed compatible. Keep the previous plugin release on older DSH. [Validation record](.github/reviews/dsh-0.1.5.md).

Download the archive from the [GitHub Release](https://github.com/Rice00/dsh-tree-view/releases/tag/v1.1.0), then run `dsh plugin --profile desktop add ./dsh-tree-view-1.1.0.tgz`.

Version `1.1.0` has been verified in an isolated DSH `0.1.5-rc.2` Web environment:
plugin loading, images, edit/retry, nested branches, and restored sessions. Model
responses use a local test adapter; remote model services were not exercised.

The compatibility layer retains the older `events` / `seedLength` interfaces,
covered by automated tests. Later DSH releases need separate verification.
Restart DSH after updating the plugin.

Coexists with [dsh-plugin-smooth-stream](https://github.com/SpookySandwich/dsh-plugin-smooth-stream) and [dsh-plugin-rollout-scout](https://github.com/SpookySandwich/dsh-plugin-rollout-scout).

## License

MIT © SpookySandwich. Portions of the host half derive from dsh-message-edit (MIT © Moeblack).
