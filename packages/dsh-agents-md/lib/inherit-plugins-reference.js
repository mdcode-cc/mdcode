/**
 * The exact `inheritPlugins` row set `profiles/cc/cordis.patch.yml` passes
 * to this plugin's `cc-agents-md` row — kept here too so `test/
 * inherit-plugins.test.js` can validate every row's config against the real
 * package's own `Config` schema (schemastery throws on a missing required
 * field with no default). The profile owns the composition (see README,
 * "`inheritPlugins` is how the `cc` profile hands every generated preset the
 * same tool surface"); this file is a validated reference, not a runtime
 * default — `index.js`'s own `Config.inheritPlugins` still defaults to `[]`.
 *
 * `sampleOverCapGlobResults: false` and `allowParallelInProgress: true` are
 * both `.required()` fields with no `.default()` on their own package's
 * `Config` (`dsh-tool-fs-search`, `dsh-tool-todo`) — an empty `{}` config on
 * either row throws `missing required value` at mount, which is exactly what
 * made every one of the 15 real presets fail activation before this fix. The
 * two values themselves are copied from a real, live, working
 * composition (`~/.dsh/.agent-presets/example-preset/agent.cordis.yml`).
 */
export const referenceInheritPlugins = [
  { name: '@deepseek-ai/dsh-tool-fs' },
  { name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
  { name: '@deepseek-ai/dsh-tool-bash' },
  { name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  { name: '@deepseek-ai/dsh-tool-skill' },
  { name: '@deepseek-ai/dsh-skill-filesystem' },
  { name: '@deepseek-ai/dsh-tool-ask-user' },
  {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
      { name: '@deepseek-ai/dsh-compaction-basic' },
    ],
  },
]
