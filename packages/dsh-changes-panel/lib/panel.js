/**
 * @mdcode-cc/dsh-changes-panel — the TUI panel component factory.
 *
 * SINGLE-REACT RULE: every hook and element here comes from `props.React`
 * and `props.ui` — never a locally-imported React/ink. No JSX (no build
 * step): everything is `React.createElement`.
 */

/** Keeps the tail (so the basename stays visible) when `text` is longer
 * than `maxWidth`, prefixing an ellipsis. */
export function truncateLeft(text, maxWidth) {
  if (maxWidth <= 0) return ''
  if (text.length <= maxWidth) return text
  if (maxWidth <= 1) return '…'.slice(0, maxWidth)
  return `…${text.slice(text.length - (maxWidth - 1))}`
}

function formatCounts(entry) {
  if (entry.binary) return 'bin'
  return `+${entry.added} -${entry.deleted}`
}

/** Fallback subscription hook for a host React without `useSyncExternalStore`. */
function useWatcherFallback(React, watcher) {
  const [state, setState] = React.useState(() => watcher.getSnapshot())
  React.useEffect(() => {
    setState(watcher.getSnapshot())
    return watcher.subscribe(() => setState(watcher.getSnapshot()))
  }, [])
  return state
}

function renderSection(React, ui, theme, label, entries, width) {
  if (entries.length === 0) return null
  const h = React.createElement
  const pathWidth = Math.max(4, width - 10)
  const rows = entries.map((entry, index) => h(ui.Box, { key: `${label}-${index}`, flexDirection: 'row', justifyContent: 'space-between' },
    h(ui.Text, null, `${entry.x}${entry.y} ${truncateLeft(entry.display ?? entry.path, pathWidth)}`),
    h(ui.Text, { color: entry.binary ? theme?.colors?.muted : undefined }, formatCounts(entry)),
  ))
  return h(ui.Box, { key: label, flexDirection: 'column' },
    h(ui.Text, { bold: true }, label),
    ...rows,
  )
}

/** createChangesPanel({ watcher, config }) -> a TuiPanelProps component. */
export function createChangesPanel({ watcher, config }) {
  return function ChangesPanel(props) {
    const { React, ui, host, width, visible } = props
    const h = React.createElement

    const hasSyncStore = typeof React.useSyncExternalStore === 'function'
    const data = hasSyncStore
      ? React.useSyncExternalStore(watcher.subscribe, watcher.getSnapshot)
      : useWatcherFallback(React, watcher)

    const tick = ui.useAnimationTime(visible ? config.refreshMs : null)

    React.useEffect(() => {
      watcher.refresh()
      // Mount-only: deliberately no deps beyond the empty array.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    React.useEffect(() => {
      if (tick !== null && tick !== undefined) watcher.refresh()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tick])

    React.useEffect(() => {
      let cwd
      try {
        cwd = host?.snapshot?.()?.cwd
      } catch {
        cwd = undefined
      }
      if (cwd && typeof watcher.setCwd === 'function') watcher.setCwd(cwd)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    let theme
    try {
      theme = ui.useTheme?.()
    } catch {
      theme = undefined
    }

    if (!data || data.loading) return h(ui.Text, null, 'Loading…')
    if (data.ok === false) return h(ui.Text, { color: theme?.colors?.danger }, data.error ?? 'git error')
    if (data.repo === false) return h(ui.Text, null, 'Not a git repository')

    const staged = data.staged ?? []
    const unstaged = data.unstaged ?? []
    const untracked = data.untracked ?? []
    const totals = data.totals ?? { files: 0, added: 0, deleted: 0 }

    if (totals.files === 0) {
      return h(ui.Box, { flexDirection: 'column' },
        h(ui.Text, null, data.branch ? `${data.branch}` : ''),
        h(ui.Text, null, 'No changes'),
      )
    }

    const header = `${data.branch ?? '-'}  ${totals.files} files, +${totals.added} -${totals.deleted}`

    const sections = [
      renderSection(React, ui, theme, 'Staged', staged, width),
      renderSection(React, ui, theme, 'Unstaged', unstaged, width),
      renderSection(React, ui, theme, 'Untracked', untracked, width),
    ].filter(Boolean)

    const more = data.truncated > 0 ? h(ui.Text, { color: theme?.colors?.muted }, `+${data.truncated} more`) : null

    return h(ui.Box, { flexDirection: 'column' },
      h(ui.Text, { bold: true }, header),
      h(ui.Divider, null),
      h(ui.ScrollBox, { flexDirection: 'column' }, ...sections, more),
    )
  }
}
