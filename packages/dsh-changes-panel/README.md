# @mdcode-cc/dsh-changes-panel

A dsh-TUI side panel showing the session cwd's git
working tree: staged, unstaged and untracked files, each with per-file
added/deleted line counts and a header line (branch + totals).

Data comes straight from `git` via `node:child_process` `execFile` — three
calls, run concurrently: `git status --porcelain=v1 -z --branch
--untracked-files=all`, `git diff --numstat -z`, `git diff --cached
--numstat -z`. It does NOT use `ctx.workspaceChanges`: that service is
composed only by `@deepseek-ai/dsh-web-app`, is not mounted in the `cc`
profile, and is turn-granular with no staged/unstaged split — none of
which this panel needs to match.

## Config

| key | default | notes |
| --- | --- | --- |
| `refreshMs` | `2000` | Poll interval (ms) while the panel is the active one. Integer, 250–60000. |
| `maxFiles` | `200` | Cap on rendered rows across staged+unstaged+untracked; the rest show as `+N more`. Integer, 1–2000. |
| `untracked` | `true` | Include untracked files (`git --untracked-files=all`). |
| `timeoutMs` | `2000` | Per-git-invocation timeout (ms). Integer, 100–30000. |

## Seam

Registers through `ctx.tuiPanels` (`TuiPanelRuntime`, loader id
`dsh-tui-panels`), reached via `ctx.inject(['tuiPanels'], cb)` — never a
direct property read, since cordis's ctx proxy throws synchronously on any
unresolved property (`ctx.tuiPanels?.x` would still crash `apply()`). If no
TUI is composed, the callback never fires and this plugin is a silent
no-op — not an error. No `@deepseek-harness-tui/dsh-tui` dependency is
declared; the panel-API shape is a local structural contract, documented
in `lib/panel.js`'s header comment.

An optional `@deepseek-harness-tui/dsh-tui` peer (to make a future bump
past panel API v1 visible to `scripts/doctor.sh`) was tried and reverted:
adding it — even as `peerDependenciesMeta.optional`— makes `pnpm install`
at the workspace root try to resolve `dsh-tui` and its own transitive
deps from the public registry (this workspace deliberately excludes
`profiles/*`, and `dsh-tui`, specifically so the plugin packages never
need to resolve or build it — see `pnpm-workspace.yaml`'s own comment),
which failed outright: `ERR_PNPM_NO_MATCHING_VERSION` on
`@deepseek-ai/dsh-llm@>=0.1.1 <0.2.0-0`, a transitive range `dsh-tui`
pulls in that the public registry does not satisfy. `scripts/doctor.sh`
also would not have actually checked this peer anyway: its plugin
peer-range loop only inspects names starting with `@deepseek-ai/`, so a
`@deepseek-harness-tui/*` entry is invisible to it as written today. Not
added; this is a real constraint of this workspace's install graph, not a
style choice.

Descriptor registered:

```js
{ apiVersion: 1, id: 'changes', title: 'Changes', icon: '±', order: 37, minColumns: 28, component }
```

**The final panel id is NOT `dsh-changes-panel:changes`.** The id prefix
comes from `pluginIdFor()` -> `componentIdentityOf(caller)`, and a real
component identity is only ever created by `bindComponentIdentity`, called
from exactly one place: the `dsh-plugin.json` Component admission path
(`dsh-adapter/plugin-host.js:427`). This package ships no `dsh-plugin.json`
manifest (out of this package's scope — see below), so that path never
runs for it, and the id prefix falls back to `session:act<N>`, giving an id
shaped like `session:act3:changes` — which the host's own
`isTemporarySidePanelId` check treats as a temporary, session-scoped
panel, not a stable registered one. The exact `<N>` depends on activation
order and is not predictable from this README. Practically: there is no
fixed id to tick in a `sidePanel.panels` list, so the panel only shows up
today because the default `sidePanel.panels` value is `'*'` (every
registered panel) — see "Visibility note" below. Adding a manifest to get
a stable id is a scope decision for the maintainer, not made here.

`order: 37` ranks this panel only among OTHER PLUGIN panels —
`PanelStore.compareEntries` sorts every `source: 'builtin'` panel (which
includes `workspace`, order 35) ahead of every plugin panel first, and
only applies `order` as a tiebreaker within each group. So `order: 37`
does NOT place this panel next to the built-in `workspace` panel in the
rendered list.

No `compact` row: in dsh-TUI 0.18.0, a plugin panel's `compact` descriptor
is validated then replaced with `() => null` server-side — it never
actually renders, so this package doesn't build one.

## Activation in a profile

Two edits (already applied in this repo's `cc` profile):

1. `profiles/cc/package.json` — `"@mdcode-cc/dsh-changes-panel":
   "link:../../packages/dsh-changes-panel"` under `dependencies`.
2. `profiles/cc/cordis.patch.yml` — a `cc-changes-panel` row inside the
   mdcode-plugins `insert:` list (section 3).

**Opening the column at all.** Verified against dsh-TUI 0.18.0's
`lib/settings.json`: `shortcuts.sidePanel` defaults to `null` and
`sidePanel.open` defaults to `false`. There is NO default keybinding for
the side-panel column — it is closed on a fresh install and no keystroke
opens it until you either set `sidePanel.open: true` or bind a key to
`shortcuts.sidePanel` yourself. This is a host default, nothing to do with
this plugin, but it is the first thing to check when the panel seems
missing.

**Visibility note:** a registered panel only shows up in that
column if the user's `sidePanel.panels` setting is `'*'` (all registered)
or this panel's id is explicitly ticked. For THIS panel, "explicitly
ticked" doesn't really work today: as explained above, its real id is the
unpredictable `session:act<N>:changes`, not `dsh-changes-panel:changes`
— so only the `'*'` setting (the default) actually shows it. This plugin
never writes that setting itself — the host's own registration path is
documented as never rewriting user settings, and this package follows
that rule.

## Re-render model

There is no `refresh()`/`invalidate()` push from the host. The component
re-renders on plain React state changes: `React.useSyncExternalStore`
reads the watcher's cache (falling back to `useState`+`useEffect` if the
host React predates `useSyncExternalStore`), and `ui.useAnimationTime
(visible ? config.refreshMs : null)` ticks a poll while the panel is the
active one — paused (`null`) otherwise. Plugin panels mount with
`mountPolicy: 'active'`, so the component unmounts entirely when it isn't
the active panel; polling stopping is belt-and-suspenders for the same
effect.

## Crash isolation

Three component crashes in 60s disables a panel for the session
(`PANEL_CRASH_DISABLE_THRESHOLD`). `lib/panel.js` guards every data state
(loading, non-repo, git error, empty, populated, truncated) and every call
into `host.snapshot()`, so a missing/partial snapshot never throws out of
render.

## Limitations

- **No compact row.** Not rendered by dsh-TUI 0.18.0 for plugin panels —
  building one would be dead code, so there isn't one.
- **git-only.** Does not use `ctx.workspaceChanges`; see "Seam" above for
  why.
- **Polling pauses while inactive.** `useAnimationTime` is passed `null`
  when `visible === false`, and the component unmounts anyway once it
  isn't the active panel (force-mount policy `'active'`).
- `branch` comes from `git status --branch`'s own header line parsing,
  best-effort: a detached HEAD resolves to `null`, not a commit SHA.
