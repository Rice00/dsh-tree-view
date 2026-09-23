<p align="center">
  <img src="assets/logo.png" alt="dsh-tree-view" width="180">
</p>

<h1 align="center">dsh-tree-view</h1>

<p align="center">Every branch of a conversation in <b>one tree</b>; the sidebar keeps <b>one entry</b>.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-tree-view"><img src="https://img.shields.io/npm/v/dsh-tree-view?color=cb3837&logo=npm" alt="npm"></a>
  <a href="https://github.com/Rice00/dsh-tree-view/actions/workflows/ci.yml"><img src="https://github.com/Rice00/dsh-tree-view/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license"></a>
  <img src="https://img.shields.io/badge/dsh-0.1.5--rc.2-4b8dff" alt="dsh">
</p>

<p align="center">English | <a href="README.md">简体中文</a></p>

Edit a message you already sent and the conversation **rewinds and branches** from that point, the way ChatGPT and Claude do it. The old version is not overwritten: a `‹ 2/4 ›` counter appears under the bubble, and the **Tree** tab draws the whole version tree — pan, zoom, click to jump. Every branch is a real session, the version links are durable events, and the tree survives restarts.

A **fork** of [dsh-plugin-message-edit](https://github.com/SpookySandwich/dsh-plugin-message-edit) (MIT © SpookySandwich): the upstream branching engine, tree UI and test suite are kept, and this fork promotes them from scattered sessions into **one tree, one entry**.

![demo](https://raw.githubusercontent.com/Rice00/dsh-tree-view/main/assets/demo.gif)

## Contents

- [What this fork adds](#what-this-fork-adds)
- [The rules](#the-rules)
- [Version tree](#version-tree)
- [Interface style](#interface-style)
- [Settings](#settings)
- [Install](#install)
- [How it works](#how-it-works)
- [Living with host versions](#living-with-host-versions)
- [Development and tests](#development-and-tests)
- [Documentation](#documentation)
- [Compatibility and licence](#compatibility-and-licence)

## What this fork adds

| Goal | State |
| --- | --- |
| **Rename a branch** from the tree (the sidebar title stays host-owned) | done |
| Right-click **Move to main chat** / **Collect into the tree** | done |
| **Collect every other branch** in one click | done |
| **The main-chat swap**: clicking a node collected in the tree brings it back out and puts the one you were reading away; clicking one already in the main chat just opens it; clicking a node of the version on screen only returns to the Chat tab | done |
| **Long-stretch folding**: the shared opening, and any unbranched run, fold into one node past a threshold and open again when clicked | done |
| **Hide content-less forks** switch (forks that only copied the conversation) | done |
| **Shared turns merged**: a fork's copied turns are the same nodes as its parent's | done |
| **Capability probe + archive adapter** (degrade loudly, never silently) | done |
| A truncated "last N turns" view | open |

## The rules

### One conversation, one entry

A conversation should occupy one place in the sidebar, and *which* version occupies it follows you. So **switching versions is a swap**, decided only by what you click:

| The node you click | What happens |
| --- | --- |
| **Collected in the tree** (it needs unarchiving) | It is brought back into the main chat and **the version you were reading is collected** — one swap, the sidebar still holds one entry |
| **Already in the main chat** | It just opens: nothing collected, nothing brought out — you put it there on purpose |
| **Belongs to the version on screen** | Only the **Chat tab** comes forward and that turn is flashed; no archive call of either kind |

Only two things trigger the swap: **clicking a node in the tree** and **the `‹ ›` ring under a bubble**. The app moving you (a fork from an edit, a sidebar click, the last-version restore) never changes archive membership — otherwise a single edit would quietly put the original conversation away.

Two protections stay on the version being collected: one that is already in the tree has nothing to collect, and one that is **still generating a reply** is skipped (the version you are opening is brought out regardless).

### Long-stretch folding

A deep family spends most of its canvas on the opening every branch shares. The rule and the drawing:

- A turn with **exactly one child** decides nothing, and a run of them is a **long stretch**.
- Stretches are bordered by the nodes that do matter and those always stay drawn: the origin, where the branches part (two or more children), where the line ends, and **the latest turn of the session you are reading** — the place you are adding to is never hidden inside a fold.
- Past the threshold the stretch is drawn as **one node**: click it to unfold, and the toolbar control unfolds and re-folds. It is drawn as **a stack of sheets** (offset down-right) so it cannot be mistaken for a turn card; colour comes from the card's own state — accent on the line you are reading, neutral off it.

The threshold lives in Settings: **Never / 5 / 8 / 12 / 20 or more turns** (default 8), and it counts **each stretch on its own** — a short run is not folded just because a long one is nearby.

### Collecting and bringing back

Right-click any node: **Collect into the tree** takes it out of the sidebar (archive), **Move to main chat** puts it back (unarchive). Both only flip archive membership — no session is created or deleted, and either is reversible at any time.

## Version tree

No matter how deeply conversations diverge or how many times prompts are edited, the **Tree** tab projects a clear, turn-level branching hierarchy with real-time active path highlights and instant navigation:

![Version Tree](https://raw.githubusercontent.com/Rice00/dsh-tree-view/main/assets/tree-demo.png)

## Interface style

The three interfaces this imitates differ in **where the controls sit and which ones exist**, so the preset changes exactly that — never the colours, which stay native to DSH. Nothing is invented: only Claude offers retry on a user message, and there is no share button, because the real interfaces have none.

| Preset | Controls under the bubble | Shown | Editor buttons |
| --- | --- | --- | --- |
| **ChatGPT** | edit, copy | on hover | `Cancel` / `Send` **inside** the box |
| **DeepSeek** | edit, copy | always — like DSH itself | `Cancel` / `Send` **inside** the box |
| **Claude** | **retry**, edit, copy | on hover | `Cancel` / `Save` **below** the box |

## Settings

Everything lives under **Settings → TreeView**:

| Setting | Default | What it does |
| --- | --- | --- |
| **Message control style** | DeepSeek | Where the controls under a bubble sit and which ones appear; applies live, with a preview in the panel |
| **Open the version I was last reading** | off | Coming back to a family from another conversation opens the version you had open. Never on a page load, never when you moved inside the family yourself, and never for a version the sidebar is not listing |
| **Stop the reply that is still being written** | on | Editing or retrying cancels every reply still being generated in that conversation — other versions included — before branching, so a superseded answer stops spending tokens |
| **Hide forks with no new turns** | on | A fork that only copied the conversation and never added a turn is not drawn. The Tree toolbar has the same switch |
| **Fold long straight stretches** | 8 or more turns | See "Long-stretch folding" above; Never / 5 / 8 / 12 / 20 |

## Install

```bash
dsh plugin --profile web add dsh-tree-view
```

From a checkout (recommended while developing — edits take effect immediately):

```bash
dsh plugin --profile web add file:<仓库绝对路径>
```

Restart DSH afterwards — the host half loads with the server. The interface follows DSH's display language (English / 中文).

## How it works

DSH sessions are append-only event logs with no in-session branching, so a rewind has to be built:

- The **host half** serves `/tree-view`. Editing a message creates a **new session seeded with every event before the target turn**, writes a durable `message-tree/version` marker naming what changed, and submits the edited prompt.
- Those markers are read back to reconstruct the tree, the `‹ n/m ›` ring, and which branch you are currently on.
- The marker is written with the envelope's `ignorable` flag. Plugin event types live outside the harness vocabulary, and without that flag the reader refuses to interpret the whole log — the session simply fails to open.
- The **client half** shadows only the plain `user` message node, at priority `-1`; reasoning, tool calls and steering rows keep the host renderer. The tree, the swap and the folding are all client-side view behaviour: no data is changed by looking at it.

The host-side branching logic derives from [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) (MIT © Moeblack), reworked for ChatGPT-style rewind semantics, sibling fan-out, and the interface presets above.

**Identity:** this fork's cordis id is `tree-view` and its route is `/tree-view`, separate from upstream's `message-tree`, so both plugins can be installed side by side. The **durable event type deliberately keeps upstream's `message-tree/version`**, so a conversation that upstream already branched still reads as a tree here — no data migration.

## Living with host versions

Hiding and showing sessions goes through `ctx.workspaceRegistry`: archiving is the supported `archiveSession`, unarchiving has to write the registry's own state (this build exposes **no unarchive API**). That coupling lives in exactly one file, `lib/archive-adapter.js`, which is probed once at load:

- A host upgrade that removes part of the seam is **not silent**: the boot log gets one `archive support is incomplete … missing: …` line, the panel says so in place, and the affected controls (collect, move to main chat) are disabled with the reason on hover. Everything else keeps working.
- A host that cannot read the archive set is **never guessed at**: nothing gets archived on a claim that "nothing is hidden".
- `package.json` declares the verified range in `engines.dsh` (`>=0.1.5-rc.2 <0.1.6-0`), but the real guard is the probe: a version tells you the host changed, a probe tells you **what** changed.

## Development and tests

```bash
npm run build     # bundles plugin.client.js into lib/client.js (the client half; also runs on prepack)
npm test          # checks the bundle is current, then runs every test
```

The tests are **behavioural**: the client half is mounted in jsdom through its real slot registrations, driven with real DOM events, and asserts on card attributes, POST payloads and navigation calls rather than on internals. Today that is **13 test files / 118 assertions**, covering:

- `tree.test.mjs`, tree logic, state and host payload — tree construction, sibling fan-out, ghost bridging, path highlighting;
- `client-tree-filter.test.mjs` — folding, the swap rule, the toolbar, the confirmation dialog and canvas dragging;
- `client-remember-path.test.mjs` — the last-version memory and its restore rules;
- `client-settings.test.mjs` — the settings section's name, every row and its explanation;
- plus branch menu, image rendering, registration, the archive adapter, host compatibility, session records and the seed runtime.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): host/client split, Cordis service injection, the durable event model and the HTTP route.
- [Tree Data Model](docs/TREE_DATA_MODEL.md): turn-level tree construction, sibling fan-out, ghost bridging, path highlighting, long-stretch folding and the main-chat swap.
- [Development](docs/DEVELOPMENT.md): build pipeline, unit tests and local install.

## Compatibility and licence

The `0.1.0` baseline of this fork is everything `dsh-plugin-message-edit@1.1.0` does (branching engine, version tree, interface presets), with its identity reset: package name `dsh-tree-view`, cordis id `tree-view`, route `/tree-view`, and the i18n namespace and local-storage keys renamed with it, so nothing bleeds between the two plugins when both are installed.

The verified range is `>=0.1.5-rc.2 <0.1.6-0` (`engines.dsh` in `package.json`); `0.1.5-rc.2` is what has actually been exercised. DSH moves fast, so unverified versions are not covered; restart DSH after updating the plugin.

MIT © Rice00 (dsh-tree-view). A fork of [dsh-plugin-message-edit](https://github.com/SpookySandwich/dsh-plugin-message-edit) (MIT © SpookySandwich), whose host-side branching logic derives from [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) (MIT © Moeblack). Both original copyright notices are kept in `LICENSE` as MIT requires.
