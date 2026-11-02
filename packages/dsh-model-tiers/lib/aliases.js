/**
 * The model alias table and its resolver. See ../README.md "The alias table"
 * and "Implementation notes" for `resolveAgent` and `inherit`.
 *
 * DeepSeek only. Effort is the tier knob, not the model: `haiku`/`sonnet`/
 * `opus` all route to `deepseek-flash` and differ only in `reasoningEffort`.
 * `review` is reachable only by calling `resolve('review')` explicitly — this
 * module has no notion of a `model:` key, so "never reachable from a `model:`
 * key" is enforced by callers (`dsh-task-tool`), not here.
 */

export const DEFAULT_PROVIDER = 'deepseek-official'

export const DEFAULT_ALIASES = {
  haiku: { model: 'deepseek-flash', reasoningEffort: 'low' },
  sonnet: { model: 'deepseek-flash', reasoningEffort: 'high' },
  opus: { model: 'deepseek-flash', reasoningEffort: 'max' },
  // DeepSeek has no "medium" effort (off|low|high|max); owner's `effort: medium` folds into high.
  medium: { model: 'deepseek-flash', reasoningEffort: 'high' },
  review: { model: 'deepseek-v4-pro', reasoningEffort: 'max' },
}

/** Claude-Code frontmatter keyword: "use the parent's model, don't override it." */
export const INHERIT = 'inherit'

/** DeepSeek's real reasoning-effort enum; anything outside it needs folding or is unknown. */
const RAW_EFFORTS = new Set(['off', 'low', 'high', 'max'])

/**
 * Fold a Claude-Code-style effort name into a DeepSeek `reasoningEffort`.
 * `off`/`low`/`high`/`max` pass through unchanged. Anything else (just
 * `medium` in a typical roster) is looked up in the SAME alias table used
 * for model names, reusing `medium`'s `reasoningEffort: 'high'` row rather
 * than hardcoding the fold a second time. An unrecognized name passes
 * through unchanged (the adapter rejects it with `UNSUPPORTED_REASONING_EFFORT`).
 */
function foldEffort(effort, aliases) {
  if (effort === undefined) return undefined
  if (RAW_EFFORTS.has(effort)) return effort
  const entry = aliases[effort]
  return entry?.reasoningEffort ?? effort
}

/**
 * Build a resolver bound to one config.
 *
 * `resolveDetailed(name)` looks `name` up in `config.aliases`. A hit returns
 * `{provider, model, reasoningEffort?, maxTokens?, alias, known: true}`. A
 * miss passes `name` through as an exact model id on `config.provider`
 * (`{provider, model: name, known: false}`) and warns once per distinct
 * unknown name — a typo'd id that still "works" is a silent cost change, so
 * it must not pass silently. `name === 'inherit'` is special: it returns
 * `{inherit: true}` with no provider/model, meaning "do not build an
 * override at all."
 *
 * `resolve(name)` is the same lookup with the diagnostic fields stripped,
 * shaped for direct use as an `LlmCallConfig`; it returns `undefined` for
 * `'inherit'` instead of a config object, so a caller can tell "no override"
 * apart from "route to this literal string as a model id."
 *
 * `resolveAgent({model, effort})` is the two-key form real agent frontmatter
 * actually uses (e.g. `model: haiku` + `effort: medium`): it resolves
 * `model` exactly like `resolve()`, then — when `effort` is given — folds it
 * through `foldEffort()` and OVERRIDES the tier's own default
 * `reasoningEffort` with the folded value. `model: 'inherit'` short-circuits
 * to `undefined` regardless of `effort` (nothing to override onto).
 */
export function createResolver(config, logger) {
  const aliases = config.aliases
  const warned = new Set()

  function warnUnknown(name) {
    if (warned.has(name)) return
    warned.add(name)
    try {
      logger.warn(`dsh-model-tiers: unknown model "${name}" passed through as an exact id on ${config.provider}`)
    } catch {
      // A log line must never be the reason a request fails.
    }
  }

  function resolveDetailed(name) {
    if (name === INHERIT) return { inherit: true }
    const entry = aliases[name]
    if (entry !== undefined) {
      return {
        provider: config.provider,
        model: entry.model,
        reasoningEffort: entry.reasoningEffort,
        ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
        alias: name,
        known: true,
      }
    }
    warnUnknown(name)
    return { provider: config.provider, model: name, known: false }
  }

  function resolve(name) {
    const detailed = resolveDetailed(name)
    if (detailed.inherit === true) return undefined
    const { alias, known, ...rest } = detailed
    return rest
  }

  function resolveAgent({ model, effort } = {}) {
    const detailed = resolveDetailed(model)
    if (detailed.inherit === true) return undefined
    const { alias, known, ...rest } = detailed
    if (effort === undefined) return rest
    return { ...rest, reasoningEffort: foldEffort(effort, aliases) }
  }

  return { resolve, resolveDetailed, resolveAgent, aliases }
}
