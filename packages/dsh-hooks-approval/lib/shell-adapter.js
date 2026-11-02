/**
 * Thin `{resolve, execute}` adapter over `node:child_process`, implementing
 * only the surface `@deepseek-ai/dsh-hook-protocol`'s `runHook` actually
 * calls (dsh-hook-protocol/lib/index.js: `bash.execute(bash.resolve(request))
 * .result()`, returning `{exitCode, stdout:{text}, stderr:{text}}`).
 *
 * DEVIATION from dsh-hooks-claude-code: that bridge runs hook commands
 * through the host's real `ctx.shell` (`@deepseek-ai/dsh-shell`'s
 * `ShellExecutor` — credential scrub, sandbox, process-group cancellation).
 * `ShellExecutor` is an abstract cordis `Service`; its concrete
 * implementations (`dsh-bash-local`/`dsh-bash-sandbox`) need a full cordis
 * Context (`ctx.subprocess`, timeouts, sandbox config) to construct, which
 * is out of scope for a small relay plugin and its unit tests. This adapter
 * runs hook commands unsandboxed and without credential scrubbing — the
 * same trust level any configured Claude Code hook command already runs
 * at. Production (`index.js`) and tests (`test/subprocess.test.js`) both
 * use this exact module; there is no second implementation.
 */
import { spawn } from 'node:child_process'

export function createShellAdapter() {
  return {
    resolve(request) {
      return request
    },
    execute(spec) {
      return Promise.resolve(runOne(spec))
    },
  }
}

function runOne(spec) {
  const child = spawn(spec.command, {
    shell: true,
    cwd: spec.workdir,
    env: spec.env ? { ...process.env, ...spec.env } : process.env,
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  // A hook that exits before reading stdin (or never reads it at all) makes
  // the write below hit a closed pipe — EPIPE — which is an UNCAUGHT
  // EXCEPTION on child.stdin without this listener (no 'error' handler on a
  // Writable throws synchronously/uncaught in Node), crashing the whole
  // host process. 'close'/'error' on `child` itself still fire normally and
  // settle `result` below.
  child.stdin.on('error', () => {})
  if (spec.stdin !== undefined) child.stdin.write(spec.stdin)
  child.stdin.end()

  const timer = spec.timeoutMs > 0 ? setTimeout(() => child.kill('SIGKILL'), spec.timeoutMs) : undefined
  const onAbort = () => child.kill('SIGKILL')
  spec.signal?.addEventListener('abort', onAbort)

  function cleanup() {
    clearTimeout(timer)
    spec.signal?.removeEventListener('abort', onAbort)
  }

  const result = new Promise(resolve => {
    child.on('close', exitCode => {
      cleanup()
      resolve({ exitCode, stdout: { text: stdout }, stderr: { text: stderr } })
    })
    child.on('error', error => {
      cleanup()
      resolve({ exitCode: undefined, stdout: { text: stdout }, stderr: { text: stderr + error.message } })
    })
  })

  return { result: () => result }
}
