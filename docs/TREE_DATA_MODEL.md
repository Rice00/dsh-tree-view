# Tree Data Model & Algorithms

This document details how conversation versions and turns are represented, branched, and visualized in `dsh-tree-view`.

---

## 1. Dual-Level Representation

There are two distinct levels of data representation in the system:

1. **Storage Level (Session DAG)**:
   - DSH enforces session-level isolation. Each branch is a distinct DSH session record with `parentSession`, `isSeeded`, and a separate `inheritedEventCount`.
   - The host maintains durable `message-tree/version` markers detailing which turn was edited/retried and what changed.

2. **Presentation Level (Turn-Level Branching Tree)**:
   - A user thinks of conversation branching at the **message/turn** level, not the session container level.
   - `buildTurnTree` projects the session versions into individual turn nodes.

```
Session DAG (Storage):
Session A (Original)  ──[edit turn 1]──>  Session B (Fork)

Turn Tree (Visualization):
               [Root Conversation]
                 /             \
        [A: Turn 1 (1/2)]    [B: Turn 1 (2/2) - Edited]
               |                    |
        [A: Turn 2]          [B: Turn 2]
```

---

## 2. Core Algorithms

### 2.1 Turn Tree Construction (`buildTurnTree`)
*Location: [`lib/tree-logic.js`](../lib/tree-logic.js#L173), [`plugin.client.js`](../plugin.client.js#L415)*

Transforms `versions` into an array of turn nodes:
1. **Root Conversation Node (`${rootSessionId}#root`)**: Represents the origin anchor of the conversation.
2. **Root Session Turns**:
   - Turn 1 hangs off `${rootSessionId}#root`.
   - Turn $k$ ($k > 1$) hangs off `${rootSessionId}#t${k-1}`.
3. **Forked Session Turns**:
   - For a session branched at `targetTurn = T`:
     - If $T = 1$: Turn 1 hangs off `${rootSessionId}#root` (sibling of the original Turn 1).
     - If $T > 1$: Turn $T$ hangs off `${parentSessionId}#t${T-1}` (sibling of parent's Turn $T$).
     - Subsequent turns $T+1, T+2, \dots$ hang off the previous turn in the same session (`${sessionId}#t${k-1}`).
4. **Safety Fallback**: Any node whose computed `parentId` does not exist in the graph is automatically attached to `${rootSessionId}#root`, preventing disconnected subtrees.

### 2.2 Sibling Fan-Out (`attachParentId`)
*Location: [`lib/tree-logic.js`](../lib/tree-logic.js#L9)*

When a user edits Turn 1 repeatedly (e.g. Turn 1 $\rightarrow$ Edit 1 $\rightarrow$ Edit 2 while viewing Edit 1):
- Without fan-out, edits form a chain: $A \rightarrow B \rightarrow C$.
- `attachParentId` traverses up versions of the same turn and stops at the first session that is *not* an edit of that turn ($A$).
- Result: Both Edit 1 and Edit 2 hang off $A$ as sibling branches.

### 2.3 Ghost Ancestor Recovery (`ancestorChainFromLog` & `collectFamily`)
*Location: [`lib/tree-logic.js`](../lib/tree-logic.js#L110-L171)*

If an intermediate session in a family is deleted by the user in DSH:
- The deleted session's own event log is gone.
- However, its descendant sessions inherited its prefix log (including the `message-tree/version` marker describing the deleted parent).
- `ancestorChainFromLog` inspects the surviving descendant's seed events to reconstruct deleted ancestors as **ghost nodes** (`deleted: true`).
- `collectFamily` ensures the family graph remains fully connected even when intermediate nodes are deleted.

### 2.4 Active Path Calculation
*Location: [`lib/tree-logic.js`](../lib/tree-logic.js#L318-L339)*

To highlight only the active branch path without highlighting superseded sibling branches:
1. Locate the latest turn node in `currentSessionId`.
2. Walk upwards following `parentId` pointers until reaching `${rootSessionId}#root`.
3. Mark only nodes on this walk with `onCurrentPath = true`.

### 2.5 Bubble Version Ring (`ringFor`)
*Location: [`lib/tree-logic.js`](../lib/tree-logic.js#L30-L68)*

Calculates the `‹ n/m ›` counter under a message at `turn` while viewing `sessionId`:
- Walks parent links to find the common fork point for that turn.
- Filters out deleted/ghost sessions (renumbering over surviving versions).
- Returns `{ alternatives, index }`. If fewer than 2 alternatives exist, returns `null` (counter is hidden).

### 2.6 Long-Stretch Folding (`foldLongRuns`)
*Location: [`plugin.client.js`](../plugin.client.js)*

A deep family can spend most of its canvas on turns that decide nothing. A turn with
**exactly one child** is a pass-through: the line simply continues. A run of them can be
hundreds of world units long, and there are two kinds:

- the **shared history** above the first fork (every branch below still contains it), and
- the **unbranched run** any single branch continues on afterwards.

Both fold. A run is bordered by the nodes that do matter, and those always stay drawn:
the origin (`#root`), where the branches part (two or more children), where the line ends,
and the latest turn of the session being read — so the place you are adding to is never
hidden inside a fold.

- Each run is replaced by one synthetic node, `id = <first hidden turn>#fold`, carrying
  `fold: true`, `foldCount`, `foldShared` (true only for the origin's own run) and the
  turn range it hides. Its parent is the turn *before* the run, and the run's exit
  re-parents onto it, so the chain stays connected and no card is orphaned into its own root.
- Because every hidden node has exactly one child by construction, no other node can hang
  off a hidden one; a fold cannot create a dangling parent.
- A fold inherits `current` / `onCurrentPath` only when **all** the turns it hides are on
  that line, so "the line you are reading" keeps reading as one line.
- The threshold is **per run** (`foldSharedAt`, default 8 hidden turns; 0 disables it), so a
  short run next to a long one stays drawn. The same threshold governs the toolbar control,
  which only expands and re-folds what the setting already allows — a control that folded
  shorter runs than the setting was folding three-turn runs out of nowhere. `foldModes`
  remembers "expanded" per family for the page.
- How it is drawn: three sheets offset down-right — a stack of turns with the top one
  labelled — one line of text, a chevron saying it opens, and a box taller than a bar so it
  holds its own beside a turn card. Solid border, no dashes: a fold is not a broken link.
  Colour comes from `currentColor`, so an accent fold on the line you are reading stays
  accent and the rest stay neutral.
- Folding is a client-side view decision, not a data change: `buildTurnTree` still returns
  the full tree, and `foldLongRuns(nodes, threshold)` is applied on top of it.

### 2.7 Version Switch = Main-Chat Swap (`swapOnVersionSwitch`)
*Location: [`plugin.client.js`](../plugin.client.js)*

Versions are whole sessions, and exactly one of them is the conversation's entry in the
sidebar. Switching versions swaps which one that is, and archive membership is what
expresses it — there is no extra state:

- Target **collected in the tree** (archived): bring it out (`activate`) and put the version
  you were reading away (`demote`). The conversation keeps one entry, and it follows you.
- Target **already in the main chat** (not archived): just open it. Nothing is archived and
  nothing is brought out — the reader put it there on purpose.
- Target **is the version on screen**: not a switch at all. Only the Chat tab is brought
  forward and the turn is flashed; no archive call of either kind is made.

Called from the two switches the reader makes on purpose: a node click in the tree and the
`‹ ›` ring under a bubble. The chat view's session transition deliberately does **not**
collect, so a fork, a sidebar click or the last-viewed-version restore cannot archive
anything behind the reader's back. Two protections remain on the version being collected: an
archived one has nothing to collect, and one that is still generating a reply is skipped,
because archiving mid-turn would hide work that is still arriving.

### 2.8 Subagent Sessions in a Family (`subagent`)

*Location: [`lib/index.js`](../lib/index.js)*

A subagent session is a **child session** of the conversation that spawned it: `origin:
'subagent'` in its header, `parentSession` pointing at the conversation, `delegationDepth` one
per level, and — the part that matters here — **the same `cwd`**. The family walk keys on
exactly those two things (same cwd, reachable through `parentSession`), so a subagent
conversation is swept into the family and drawn as if it were a version of the reader's
message. It has no `message-tree/version` marker, which is the only hint the client had.

Measured on this machine: 29 subagent sessions across 7 workspaces, one conversation with
four of them. So the host says what it knows and the client marks it:

- the payload carries `subagent: true` (from `header.origin`), plus `delegationDepth` when it
  is nested deeper than one level;
- every node of that version inherits the flag, so a card carries `data-subagent` and a
  `subagent` tag on its top edge — the same tag the subtitle repeats in words.

Nothing about placement changes: the version is still drawn where the walk put it. Hiding or
collapsing subagent conversations is a separate decision, not taken here.

---

## 3. Graph Layout & Springs

*Location: [`plugin.client.js`](../plugin.client.js#L567-L612)*

- **Tidy Tree Layout (`layoutTurnTree`)**:
  - Leaf nodes take successive horizontal slots (`cursor * SLOT_X`, where `SLOT_X = 206px`).
  - Parent nodes center horizontally over their children (`(min_x + max_x) / 2`).
  - Depths scale vertically (`depth * SLOT_Y`, where `SLOT_Y = 132px`).
- **Spring Physics (`springs.current`)**:
  - Cards smoothly animate to their target coordinates using critically-damped spring equations ($k = 190, c = 24$).
  - New cards spawn at their parent's coordinates and spring outward.
  - Edges are rendered as cubic SVG bezier curves connecting parent card bottoms to child card tops.
