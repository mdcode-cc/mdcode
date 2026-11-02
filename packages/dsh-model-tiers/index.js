/**
 * @markishh/dsh-model-tiers — the single place the model policy lives.
 *
 * Resolves Claude-Code-style tier names to DeepSeek routes, logs the
 * resolved route on every request (hardening (d)), and retries the two
 * protocol-level failures the host's own retry policy leaves terminal
 * (hardening (a), fallback only). Full spec: ./README.md.
 */

import z from '@deepseek-ai/schemastery'
import { createResolver, DEFAULT_ALIASES, DEFAULT_PROVIDER } from './lib/aliases.js'
import { createRetryTracker } from './lib/retry.js'

export const name = 'dsh-model-tiers'

const AliasEntry = z.object({
  model: z.string().required(),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']),
  maxTokens: z.natural(),
})

export const Config = z.object({
  provider: z.string().description('LLM route name every alias resolves to.').default(DEFAULT_PROVIDER),
  aliases: z.dict(AliasEntry).description('Alias name to DeepSeek route.').default(DEFAULT_ALIASES),
  logResolvedRoute: z.boolean().description('(d) Log provider/model/effort for every model request.').default(true),
  logLevel: z.union(['debug', 'info']).description('Level for the resolved-route line.').default('info'),
  retry: z.object({
    codes: z.array(z.string()).description('LlmFailure codes this plugin retries.').default(['MALFORMED_RESPONSE', 'STREAM_CLOSED']),
    maxAttempts: z.natural().description('Retries per step, beyond the provider policy; 0 disables.').default(2),
  }).default({}),
})

/** The durable session identity for a request's agent, or a safe placeholder. */
function sessionIdOf(agent) {
  return agent?.session?.id ?? agent?.id ?? '-'
}

/**
 * Validate the alias table against the live adapter (`ctx.llm.resolveModelInfo`)
 * and refuse to mount on a mismatch — failing at mount beats failing on the
 * first `UNSUPPORTED_REASONING_EFFORT` request. No-ops when `ctx.llm` is
 * unavailable on the given `ctx` (e.g. a fake test ctx, or before `apply`
 * routes through `ctx.inject` below).
 */
async function validateAliases(ctx, config) {
  const llm = ctx.get ? ctx.get('llm') : undefined
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return
  for (const [aliasName, entry] of Object.entries(config.aliases)) {
    let info
    try {
      info = await llm.resolveModelInfo(config.provider, entry.model)
    } catch {
      continue // Adapter can't answer yet; don't block mount on a transient lookup failure.
    }
    const efforts = info?.reasoning?.efforts
    if (efforts === undefined || entry.reasoningEffort === undefined) continue
    if (!efforts.some(effort => effort.id === entry.reasoningEffort)) {
      throw new Error(
        `dsh-model-tiers: alias "${aliasName}" sets reasoningEffort "${entry.reasoningEffort}", `
        + `which ${config.provider}/${entry.model} does not support`,
      )
    }
  }
}

export async function apply(ctx, config) {
  const logger = ctx.logger
  const { resolve, resolveDetailed, resolveAgent, aliases } = createResolver(config, logger)
  const retryTracker = createRetryTracker(config.retry)

  ctx.provide('modelTiers', { resolve, resolveDetailed, resolveAgent, aliases })

  // Mount validation. `ctx.get('llm')` is a one-shot snapshot: if `llm`
  // activates AFTER this plugin mounts, a plain `ctx.get()` check here would
  // silently see nothing and never re-check, breaking the "refuses to mount
  // on a mismatch" promise. `ctx.inject(['llm'], …)` instead starts the
  // validation once `llm` becomes available, whenever that is; it is
  // disposed with this plugin either way. When the current `ctx` has no
  // `inject` (a fake test ctx), fall back to the original one-shot check so
  // a synchronously-available mismatch still rejects `apply()` itself.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], injectedCtx => validateAliases(injectedCtx, config))
  } else {
    await validateAliases(ctx, config)
  }

  if (config.logResolvedRoute) {
    // (d) one unconditional log line per request. Wrapped: "plugin failure
    // ends the turn, not the loop" (dsh-agent-loop/README.md) — a log line
    // must never be the thing that ends it.
    ctx.on('agent/request', async ({ agent, turn, step }, next) => {
      const resolved = await next()
      try {
        const effort = resolved.reasoningEffort ?? '-'
        logger[config.logLevel](
          `model-tiers: turn=${turn} step=${step} provider=${resolved.provider} model=${resolved.model} effort=${effort} agent=${sessionIdOf(agent)}`,
        )
      } catch {
        // See the comment above: a logging failure must not close the turn.
      }
      return resolved
    })
  }

  // (a) fallback retry for MALFORMED_RESPONSE / STREAM_CLOSED. The config
  // route (retryPolicy.retryableCodes on the llm-deepseek row) is preferred
  // and should already cover the DeepSeek route; this exists for a gateway
  // or future provider the deployment cannot edit the adapter row for.
  ctx.on('agent/request-error', (payload, next) => {
    const { agent, turn, step, failure, signal } = payload
    if (signal?.aborted) return undefined // Cancellation: never retry, never recurse into next().
    if (retryTracker.shouldRetry(sessionIdOf(agent), turn, step, failure.code)) return { kind: 'retry' }
    return next()
  })
}

export default { name, Config, apply }
