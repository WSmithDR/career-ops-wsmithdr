/**
 * .shared/hooks/runtime-env.mjs
 *
 * Provides the environment a headless AI CLI needs to run Chromium.
 *
 * THE FAILURE THIS PREVENTS
 * Playwright could not launch at all: `libnspr4.so: cannot open shared object
 * file`. Playwright 1.63 and the Chromium builds were present; five shared
 * libraries were not. This machine has no passwordless sudo, so the libraries
 * were extracted from their Ubuntu packages with `dpkg-deb -x` into
 * ~/.local/share/playwright-libs and exposed via LD_LIBRARY_PATH.
 *
 * That fix lives in ~/.bashrc, which covers interactive shells only. A headless
 * `opencode run` / `claude -p` session, a cron entry, or a systemd timer does not
 * source ~/.bashrc — so every automated run hit the same missing-library error
 * even though the interactive session worked. A third copy of the path was
 * hardcoded into a wrapper script.
 *
 * Making it a shared hook means any CLI adapter inherits the fix instead of
 * re-deriving it.
 *
 * REGRESSION NOTE, worth keeping: an earlier version of this logic lived in the
 * opencode adapter and did
 *     output.env.PATH = output.env.PATH ? bin + ":" + PATH : bin
 * so when the CLI supplied no PATH of its own, the result was a PATH containing
 * ONLY ~/.local/bin — and every spawned command failed with
 * "node: command not found". PATH IS PREPENDED TO, NEVER REPLACED. The
 * `env-paths.mjs` tests pin that.
 *
 * Pure decision logic: returns key/value pairs, writes nothing.
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { EVENTS, ORDER } from "./contract.mjs"

export const id = "runtime-env"
export const description = "Expose the Chromium runtime libs and user bins to headless sessions"
export const order = ORDER[EVENTS.BUILD_ENV]

export const LIB_DIR = ".local/share/playwright-libs"
export const BIN_DIR = ".local/bin"

const exists = (p) => { try { return !!p && existsSync(p) } catch { return false } }

/**
 * Decide the env additions for a child process.
 *
 * @param {{env?:Record<string,string>, home?:string}} payload
 * @returns {Record<string,string>} vars to merge (may be empty)
 */
export function computeEnv({ env = {}, home = homedir() } = {}) {
  const add = {}

  const libs = join(home, LIB_DIR)
  if (exists(libs)) {
    const cur = env.LD_LIBRARY_PATH
    if (!cur) add.LD_LIBRARY_PATH = libs
    else if (!cur.split(":").includes(libs)) add.LD_LIBRARY_PATH = `${libs}:${cur}`
  }

  const bin = join(home, BIN_DIR)
  if (exists(bin)) {
    const cur = env.PATH
    // Prepend only. When PATH is absent we return nothing at all rather than
    // inventing one — assigning a bare directory here is what broke every
    // spawned command in the previous implementation.
    if (cur && !cur.split(":").includes(bin)) add.PATH = `${bin}:${cur}`
  }

  return add
}

export function run(event, payload) {
  if (event !== EVENTS.BUILD_ENV) return null
  const additions = computeEnv(payload || {})
  return Object.entries(additions).map(([key, value]) => ({ key, value }))
}

export default { id, description, order, run, computeEnv, LIB_DIR, BIN_DIR }
