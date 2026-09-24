<p align="center">
  <img src="assets/logo.png" alt="dsh-tree-view" width="180">
</p>

<h1 align="center">dsh-tree-view</h1>

<p align="center">One conversation = one tree = one sidebar entry</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-tree-view"><img src="https://img.shields.io/npm/v/dsh-tree-view?color=cb3837&logo=npm" alt="npm"></a>
  <a href="https://github.com/Rice00/dsh-tree-view/actions/workflows/ci.yml"><img src="https://github.com/Rice00/dsh-tree-view/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license"></a>
  <img src="https://img.shields.io/badge/dsh-0.1.5--rc.2-4b8dff" alt="dsh">
</p>

<p align="center">English | <a href="README.md">简体中文</a></p>

Edit a message you already sent and the conversation **rewinds and branches from that point** — the way ChatGPT and Claude do it, not a fork that continues from the end. Nothing is overwritten: a `‹ 2/4 ›` counter appears under the bubble, and the **Tree** tab draws the whole thing.

That is what separates this from a plain "edit message" plugin: it does not just let you change a sentence, it gives **every branch of a conversation somewhere to live**.

![demo](assets/demo.gif)

## The 30-second version

- **Edit a message to rewind** — regenerate from before that turn, with the full context intact.
- **Branches are a tree** — pan, wheel-zoom and click to jump in the Tree tab, with the line you are reading highlighted live.
- **One sidebar entry per conversation** — switching versions swaps the entry instead of piling up more of them.
- **Big families stay readable** — long straight stretches with no branching fold into one node, and open when clicked.

## What it does

### 1. The main-chat swap: one conversation, one entry

A conversation should occupy one place in the sidebar, and **which version occupies it follows you**. So a click is a swap:

| The node you click | What happens |
| --- | --- |
| **Collected in the tree** (in the tree, not in the sidebar) | It **comes back into the main chat** and the version you were reading is **collected into the tree** |
| **Already in the main chat** | It **just opens** — nothing collected, nothing brought out |
| **Part of the version you are reading** | Only the **Chat tab** comes forward, positioned at that turn |

Only two things trigger the swap: **clicking a node in the tree** and **the `‹ ›` ring under a bubble**. Everything else — a fork from an edit, opening a conversation from the sidebar, the last-version restore — **never touches archive membership**. That is deliberate: otherwise one stray edit would quietly put the original conversation away.

Two protections: a version that is still generating a reply is never collected, and one that is already in the tree has nothing left to collect.

### 2. Long-stretch folding: a big family is not one long pole

Inside a family, the opening every branch shares and any stretch a single branch runs straight through have no decision in them at all, yet they eat most of the canvas. So:

- **Past the threshold they fold into one node** — Settings offers **Never / 5 / 8 / 12 / 20 or more turns** (default 8). The threshold counts **each stretch on its own**, so a short run is never folded just because a long one is nearby.
- **Click it to unfold**, and the toolbar control unfolds and re-folds.
- **Nothing you need is ever hidden** — the origin, the branch point, the end of the line, and **the turn you are writing** never fold away.
- **Unmistakable at a glance** — a fold is drawn as a stack of sheets (offset down-right), and takes its colour from the card's state: accent on the line you are reading, neutral off it.

### 3. The version tree

The **Tree** tab draws the whole family as a turn-level graph: pan it, wheel-zoom it, click any node to jump straight there. The line you are reading — including the shared history above it — is highlighted together, so "where I came from, where I am, where I can still go" is one look.

![Version tree](assets/tree-demo.png)

### 4. Collect and bring back, always reversible

Right-click any node: **Collect into the tree** takes it out of the sidebar, **Move to main chat** puts it back. Both only flip archive membership — no session is created or deleted, and you can change your mind any time.

### 5. One place for every switch

All under **Settings → TreeView**:

| Switch | Default | What it does |
| --- | --- | --- |
| **Message control style** | DeepSeek | ChatGPT / DeepSeek / Claude button layouts, previewed live in the panel |
| **Open the version I was last reading** | off | Coming back to a family from another conversation opens the version you had open |
| **Stop the reply that is still being written** | on | Editing or retrying first stops every reply still running in that family — saves tokens, and lets you edit mid-reply |
| **Hide forks with no new turns** | on | A fork that only copied the conversation and never added a turn is not drawn |
| **Fold long straight stretches** | 8 or more turns | See "Long-stretch folding": Never / 5 / 8 / 12 / 20 |

## Install

```bash
dsh plugin --profile web add dsh-tree-view
```

**Restart DSH** afterwards — the host half loads with the server. The interface follows DSH's display language.

While developing, install the checkout directly so edits take effect immediately:

```bash
dsh plugin --profile web add file:<path-to-checkout>
```

## How it works

A DSH session is an append-only event log with no in-session branching, so a rewind has to be built. Three steps:

1. **Seed a new session.** Editing a message makes the host create a new session seeded with *every event before the target turn*, write a durable `message-tree/version` marker saying what changed, and submit the edited prompt. That is what makes it a real rewind.
2. **Read the markers back.** The client reconstructs the tree, the `‹ n/m ›` counter and which line you are standing on from those markers.
3. **The `ignorable` flag is not optional.** Plugin event types live outside the host's vocabulary; without that envelope flag the reader refuses to interpret the whole log and the session will not open at all.

Drawing the tree, the swap and the folding are **all client-side view behaviour** — no data is touched by looking at it.

The host-side branching engine comes from [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) (MIT © Moeblack); this fork reworks it into ChatGPT-style rewind semantics and the rules above.

**Identity:** this fork's cordis id is `tree-view` and its route is `/tree-view`, separate from upstream's `message-tree`, so both plugins can be installed side by side. The **durable event type deliberately keeps upstream's `message-tree/version`**, so a conversation upstream already branched still reads as a tree here — no data migration.

## It fails loudly, never silently

Hiding and showing versions goes through `ctx.workspaceRegistry`: archiving uses the supported `archiveSession`, and unarchiving has to write the registry's own state (this build exposes **no unarchive API**). That coupling lives in one file, `lib/archive-adapter.js`, probed once at load:

- If a host upgrade removes part of the seam, the plugin **does not pretend otherwise**: the boot log gets one `archive support is incomplete … missing: …` line, the panel says so in place, and the affected controls (collect, move to main chat) are disabled with the reason on hover. Everything else keeps working.
- If the archive set cannot be read, the plugin **does not guess**: it would rather do nothing than claim "nothing is hidden".

## Development and tests

```bash
npm run build   # bundle the client half: plugin.client.js -> lib/client.js
npm test        # check the bundle is current, then run every test
```

The tests are **behavioural**: the client half is mounted in jsdom through its real slot registrations, driven with real DOM events, and asserts on card attributes, POST payloads and navigation calls rather than on internals. Today: **13 files / 118 assertions**, covering tree construction, the fold and swap rules, the toolbar and confirmation dialog, the settings panel, the remember/restore rules, image rendering, registration and degradation, the archive adapter and host compatibility.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — host/client split, Cordis service injection, the durable event model and the HTTP route.
- [Tree Data Model](docs/TREE_DATA_MODEL.md) — turn-level tree construction, sibling fan-out, ghost bridging, path highlighting, long-stretch folding, the main-chat swap.
- [Development](docs/DEVELOPMENT.md) — build pipeline, tests and local install.

## Compatibility and licence

- Verified against dsh **`0.1.5-rc.2`**; `engines.dsh` declares `>=0.1.5-rc.2 <0.1.6-0`. DSH moves fast, so unverified versions are not covered; restart DSH after updating the plugin.
- MIT © Rice00 (dsh-tree-view). A fork of [dsh-plugin-message-edit](https://github.com/SpookySandwich/dsh-plugin-message-edit) (MIT © SpookySandwich), whose host-side branching logic derives from [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) (MIT © Moeblack). Both original copyright notices are kept in `LICENSE` as MIT requires.
