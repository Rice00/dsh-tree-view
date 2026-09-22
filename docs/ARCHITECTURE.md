# Architecture Overview

`dsh-tree-view` provides ChatGPT/Claude-style conversation branching and message editing for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

Because DSH session event logs are append-only without native in-session branching, this plugin splits responsibilities across a **Node.js Host Service** and a **Browser/Web Client**.

---

## 1. System Components

```
┌─────────────────────────────────────────────────────────────┐
│                      DSH Desktop / Web                      │
│                                                             │
│  ┌──────────────────────┐         ┌──────────────────────┐  │
│  │     Client Half      │  HTTP   │      Host Half       │  │
│  │  (plugin.client.js)  │<───────>│    (lib/index.js)    │  │
│  └──────────┬───────────┘         └──────────┬───────────┘  │
│             │                                │              │
│    Shadow User Message              Cordis Services:        │
│    Versions Tab (Graph)             - sessions              │
│    Settings UI                      - agents                │
│                                     - webServer             │
│                                     - sessionPersistence    │
└─────────────────────────────────────────────────────────────┘
```

### 1.1 Host Half (`lib/index.js`)
- Runs in the Node.js backend process via Cordis lifecycle injection.
- Normalizes DSH sessions through `lib/session-record.js`: current live sessions
  expose `snapshotEvents()`, query snapshots carry their header in `session`,
  and older records expose `events` / `header`. Invalid logs fail explicitly.
- DSH 0.1.5 branches use `meta.isSeeded` plus `inheritedEventCount`, which must
  equal the complete constructor seed length. New markers carry their owning
  `sessionId`; old markers without that field use the legacy inherited cut.
  Cold logs use `observeSession(..., { projectionMode: 'none' })` and release
  the observation lease; this restores seeded sessions through the correct API.
- Registers the `/tree-view` HTTP route on `ctx.webServer`.
- Touches the host's workspace registry only through `lib/archive-adapter.js`,
  which is the single place holding that coupling: the archive set
  (`archivedSessionIds`), archiving (`archiveSession`), and unarchiving — which
  this build leaves to plugins, so the adapter mirrors the registry's own state
  discipline (same operation queue, same read, same write). `probe()` reports
  what the running host supports; the payload carries it as `archiveSupport`,
  the boot logs one line when something is missing, and the panel disables
  exactly the controls that cannot work.
- Owns branch creation transactions (`POST /tree-view`):
  1. Truncates parent events up to the target turn.
  2. Adds an ignorable `message-tree/version` marker to the constructor seed.
  3. Creates the agent and clears both inherited inbox queues in its setup,
     before publication can schedule the rewound original input.
  4. Flushes the branch and submits the edited prompt exactly once.
- Owns graph queries (`GET /tree-view?sessionId=...`):
  - Traverses the session family DAG.
  - Recovers deleted/ghost ancestors from surviving descendants' event logs.
  - Extracts turn event boundaries for turn-level rendering.

### 1.2 Client Half (`plugin.client.js`)
- Runs in the browser / renderer process.
- Injects a shadowed `user` message renderer at priority `-1` to add the edit/copy/retry toolbar and `‹ n/m ›` version ring without modifying agent responses, tool calls, or reasoning blocks.
- Adds the **Versions** tab (`VIEW_ORDER: 16`) providing an interactive pan/zoom graph with spring physics.
- Adds settings options in **Settings → Message Edit** with live layout switching (ChatGPT, DeepSeek, Claude styles).

---

## 2. Durable Storage Model

DSH sessions are immutable append-only logs. When branching:

1. **Seed Inheritance**: Copy the parent prefix before the edited turn, then add the plugin marker. The full constructor seed is inherited on DSH 0.1.5; the kernel adds its own `session/end-seed` afterwards.
2. **Durable Marker**: The seed carries a custom event with explicit child ownership:
   ```json
   {
     "type": "message-tree/version",
     "data": {
       "schemaVersion": 1,
       "sessionId": "child-session-id",
       "effect": {
         "operation": "edit",
         "targetTurn": 1,
         "targetEventSeq": 5,
         "before": "Original message text",
         "after": "Edited message text"
       },
       "inverse": {
         "kind": "restore-version",
         "sessionId": "parent-session-id"
       }
     }
   }
   ```
3. **`ignorable` Flag**: Custom plugin event types fall outside DSH's core schema. The event envelope must set `ignorable: true`; otherwise, DSH's built-in event reader will reject the entire session log.

---

## 3. HTTP API

### `GET /tree-view?sessionId={id}`
Returns the entire conversation family surrounding the requested session.

**Response Schema:**
```json
{
  "sessionId": "current-session-id",
  "versions": [
    {
      "sessionId": "session-a",
      "createdAt": 1724334000000,
      "depth": 0,
      "current": false,
      "onCurrentPath": true,
      "turns": [
        { "turn": 1, "text": "Hello", "time": 1724334001000 },
        { "turn": 2, "text": "Tell me more", "time": 1724334005000 }
      ]
    },
    {
      "sessionId": "session-b",
      "parentSessionId": "session-a",
      "createdAt": 1724334020000,
      "depth": 1,
      "current": true,
      "onCurrentPath": true,
      "operation": "edit",
      "targetTurn": 1,
      "before": "Hello",
      "after": "Hello world",
      "turns": [
        { "turn": 1, "text": "Hello world", "time": 1724334021000 },
        { "turn": 2, "text": "What is next?", "time": 1724334025000 }
      ]
    }
  ]
}
```

### `POST /tree-view`
Performs branch creation or reactivation.

- **`edit`**: Rewinds to before the specified user turn, creates a new branched session, appends a durable `message-tree/version` marker, and submits the replacement prompt.
- **`retry`**: Rewinds to before the target turn, creates a child session, and replays the original user prompt.
- **`activate`**: Unarchives an archived version session via the host registry queue so the client can navigate to it.

---

## 4. Performance & In-Memory Caching

1. **Host-Side Parsed Session Cache (`sessionParsedCache`)**:
   - Parses turn boundaries (`extractTurns`) and version headers once per immutable event sequence.
   - Bounded to 500 entries per plugin context. Live keys use session identity
     and event count; unchanged modern logs do not need a new snapshot.
   - Cold logs are read before comparing their event count. Creation timestamps
     cannot invalidate append-only history and must not be used as revisions.

2. **Client-Side Family SWR Store (`treeStore`)**:
   - Maps every non-deleted branch in a tree to the shared family structure upon fetch.
   - Switching between sibling branches (`‹ n/m ›` or Versions view) is 100% synchronous (0ms lag, zero indicator flicker).
   - Uses monotonic request timestamps to prevent race-condition overwrites from out-of-order responses.
   - Optimistically seeds newly created edit/retry branches before navigation.

---

## 5. Security and Error Resilience

- **Ignorable Event Envelope**: `ignorable: true` ensures foreign event markers do not crash the core DSH log parser.
- **Fail-Safe Mutation Recovery**: Transaction reversals (`child.dispose()`) on failures prevent dangling session artifacts.
- **Memory Bounded Stores**: LRU bounds (500 sessions) prevent unbounded memory growth in long-running processes.

## 6. Naming & Namespaces

- **NPM Package**: `dsh-tree-view`
- **Cordis Service Name**: `message-tree`
- **HTTP Path**: `/tree-view`
- **Durable Event Type**: `message-tree/version`

> The package uses `dsh-tree-view` for discovery, but retains `message-tree` in routes, cordis IDs, and event types to prevent collisions with prior third-party plugins (such as `dsh-message-edit`) and ensure seamless side-by-side operation.
