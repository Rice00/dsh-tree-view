# Development & Testing Guide

This guide covers building, testing, packaging, and installing `dsh-tree-view`.

---

## 1. Repository Structure

```
dsh-tree-view/
├── lib/
│   ├── index.js           # Host-side Cordis plugin (routes, session log processing)
│   ├── tree-logic.js      # Pure tree algorithms (shared with client and tests)
│   ├── session-record.js  # Reads every session shape into one record
│   ├── tree-state.js      # Sidecar store: branch labels and collected versions
│   ├── archive-adapter.js # The one place coupled to the host's archive state
│   └── client.js          # Generated client bundle (wrapped from plugin.client.js)
├── plugin.client.js       # Source client-side UI and React components
├── scripts/
│   ├── build-client.mjs   # Build script wrapping plugin.client.js into lib/client.js
│   ├── check-package.mjs  # Packs the plugin and verifies the tarball
│   └── …                  # QA fixture and the DSH acceptance runners
├── test/                  # 16 behaviour-level test files (node:test)
├── .github/
│   ├── workflows/ci.yml   # Regression suite, package check, official-host acceptance
│   └── release-notes/     # One file per release; upstream's are named upstream-*
├── cordis.patch.yml       # Service dependencies and injection metadata
├── docs/                  # Technical architecture and data model documentation
└── package.json
```

---

## 2. Build Pipeline

The client component [`plugin.client.js`](../plugin.client.js) is written in browser-compatible JavaScript. Before distribution or testing, it is wrapped with a Cordis module preamble into [`lib/client.js`](../lib/client.js).

### Build Client
```bash
npm run build
```
Executes `node scripts/build-client.mjs` to regenerate `lib/client.js`.

### Check Build Integrity
```bash
node scripts/build-client.mjs --check
```
Exits with code 1 if `lib/client.js` is out of date relative to `plugin.client.js`.

---

## 3. Testing

The project includes an automated test suite verifying tree construction, sibling fan-out, ghost recovery, active path calculation, and ring index calculation.

```bash
npm test
```
Automatically builds the client first, checks that it matches the source, then
runs the Node test runner. Install development dependencies with `npm ci` on a
fresh checkout before running tests (Node 22.19+ or Node 24).

- `test/tree.test.mjs`: branch construction, sibling fan-out, ghost recovery,
  active-path and ring-index behaviour (custom runner; prints `all passed`).
- `test/client-*.test.mjs`: the client half through its module loader — tree
  filtering and folding, the re-frame after a fold, subagent marks, host theme
  tokens, image delegation, settings, and that a zoomed canvas is not left
  behind as a stretched GPU layer.
- `test/session-record.test.mjs`, `test/host-compatibility.test.mjs` and
  `test/tree-payload.test.mjs`: legacy and current session shapes, live and
  resumed edit requests, retained images, retry ancestry, nested version
  markers, cache invalidation, and the payload the tree view serves.

GitHub Actions runs these checks for pull requests and branch pushes, on
Linux (Node 22 and 24) and Windows (Node 22). It also runs:

```bash
npm run check:package
```

This creates a real npm archive in a temporary directory, verifies that runtime
entry points are present and development-only directories are absent, checks
the host entry's syntax, and removes the temporary archive. `npm pack` and
`npm publish` now build the client automatically through `prepack`, preventing
an old or missing generated client from being shipped.

The workflow needs to be pushed to GitHub to run there. Making its checks
mandatory before merging is a separate repository ruleset/branch-protection
setting; adding the workflow alone does not block the Merge button.

Before accepting an image-rendering change, also check it in a running DSH:
send text with one/multiple images and an image-only message, open an image in
the native viewer, enter/cancel an edit, then verify the original attachments
survive an edit submission. CI's gallery double cannot verify native image
loading, lightbox behavior, or compatibility with DSH's module injection.

To add a test, drop a `test/*.test.mjs` file: `npm test` runs the whole directory.

### Optional real DSH acceptance

`test/fixtures/dsh-acceptance.mjs` is an offline model adapter and live/cold
session fixture for an installed official DSH `0.1.5-rc.2` runtime. Mount it
only in a new temporary home whose name contains `tree-view-dsh-qa-`.
Set `DSH_HOME` to that home and `DSH_QA_MODULES` to the official runtime's
`node_modules` directory. Use a separate Web profile with the base/Web bundles,
a built copy of this plugin, and a loader entry for the fixture. Never point
this fixture at an existing user's DSH home. The fixture resolves
`@deepseek-ai/dsh-llm` and `sharp` the way the host does — from the runtime root,
then from the tree as `@deepseek-ai/dsh`, `dsh-base` and `dsh-web-app` see it,
then by scanning the tree — and names the anchors it tried when it cannot find
them, so a runtime npm has reshaped still works.

Once the isolated server prints its URL, run:

```bash
node scripts/verify-dsh-acceptance.mjs http://127.0.0.1:61587
```

The verifier exercises real HTTP edit/retry operations, local model execution,
image retention, unchanged source messages, and nested branch markers. Restart
the same isolated server and repeat to exercise persisted branches. The fixture
adds `/qa/state` and `/qa/followup` endpoints solely for this disposable test.
Browser acceptance additionally checks the settings entry, version switcher,
thumbnails, and native original-image viewer. No remote API key is needed.

For an automated fresh-boot and restart run, set `DSH_QA_MODULES` to the
official runtime's `node_modules` directory and run:

```bash
node scripts/run-dsh-acceptance.mjs
```

The runner owns and removes a unique temporary home, boots the official CLI
on an OS-selected port, runs the verifier, restarts the host, and repeats.
The restart pass explicitly resumes and retries an already seeded branch.
CI runs this on Linux and Windows in addition to the regression suite.

---

## 4. Release & Compatibility Policy

`1.0.0` freezes the plugin's own surface, and only that:

- the configuration keys the settings panel writes;
- the three durable formats: the `message-tree/version` marker written into the
  session log (`schemaVersion: 1`), the sidecar store
  `~/.dsh/storages/tree-view/state.json`, and the browser preference
  `dsh-tree-view:prefs` (`v: 2`);
- the verified host range (see the README, "版本与兼容" / "Versions and compatibility").

What that means for the next change:

| Change | Version |
|---|---|
| A durable format or a configuration key changes shape | major, with a migration |
| New behaviour, new setting, new route action — older state and older hosts keep working | minor |
| Bug fix, documentation, packaging | patch |

The host is deliberately outside that promise. `engines.dsh` names a range that
has been verified, never one that merely looks compatible, so npm cannot hand an
unverified host to a user as a supported environment. CI's `official-host` job
runs the acceptance against every host line in that range (`0.1.5-rc.2` and
`0.1.7-rc.1` at the time of writing; the matrix is in the workflow). When a new
host line ships, add it to that matrix first, watch it pass, and only then change
the range here and in `package.json`.

Two rules keep a host change from taking the plugin offline:

- **The client declares one hard dependency: `slots`.** Everything else — the
  session list, the locale pack, session navigation — is taken with
  `ctx.inject([...])` or looked up lazily through `ctx.get(name)`. A hard `inject`
  on a service the host renamed leaves the plugin parked, and DSH Desktop
  deselects a client plugin whose boot never finishes. That is exactly what
  happened on 0.1.7: it moved "show this session" from `sessions.open` to
  `uiWorkspace.openSession`, an old client threw during `apply`, and the plugin
  disappeared from the app. `sessionNavigator` in `plugin.client.js` now knows
  both generations.
- **Host coupling lives in adapters.** `lib/archive-adapter.js` probes
  capabilities instead of version-gating, and the client reads the subagent
  catalogue from either generation's field. A moved API should cost one ability,
  not the plugin.

Release checklist:

1. `npm test` — builds the client, checks it against the source, runs every file.
2. `npm run check:package` — packs for real, verifies the tarball's contents.
3. CI green on the pushed commit, `official-host` included.
4. Bump `version` in `package.json`, and describe the release in
   `.github/release-notes/v<version>.md`. The inherited notes of the upstream
   project are named `upstream-*` and are not this project's releases.
5. Commit, tag `v<version>`, push the branch and the tag.
6. `npm publish` from the tagged commit; `prepack` rebuilds the client into the
   tarball, so a stale generated client cannot be shipped.

---

## 5. Local Installation into DSH Desktop

### Step 1: Build and Package
```bash
npm run build
npm pack
```
This produces a tarball named after the version, e.g. `dsh-tree-view-1.0.0.tgz`.

### Step 2: Install into DSH Profile
To install into the DSH Desktop profile:
```bash
dsh plugin --profile desktop add file:/path/to/dsh-tree-view-1.0.0.tgz
```
Or sync files directly into `~/.dsh/profiles/desktop/node_modules/dsh-tree-view/`.

### Step 3: Restart DSH Desktop
Restart DSH Desktop to reload the host-side plugin in the server process and mount the updated client interface.
