/**
 * hook-runner.mjs — ejecuta hooks de flujo configurados en config/hooks.yml.
 *
 * Cada hook es un script .mjs que se ejecuta con `node <script>`.
 * Los hooks son advisory: un fallo imprime una advertencia y nunca bloquea
 * el flujo principal.
 *
 * Config: config/hooks.yml con secciones before-scan, after-scan, before-evaluate,
 * after-evaluate, after-tracker-add. Cada una es una lista de rutas de script.
 *
 * Uso:
 *   import { runHooks } from './lib/hook-runner.mjs';
 *   await runHooks('before-scan', { cwd, env });
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadYaml } from './yaml-document.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

const DATA_ROOT = getCareerOpsRoot();
const HOOKS_PATH = join(DATA_ROOT, 'config', 'hooks.yml');

let cached = null;

function loadConfig() {
  if (cached) return cached;
  if (!existsSync(HOOKS_PATH)) {
    cached = {};
    return cached;
  }
  try {
    cached = loadYaml(readFileSync(HOOKS_PATH, 'utf-8')) || {};
  } catch {
    cached = {};
  }
  return cached;
}

function resolveScript(script) {
  if (script.startsWith('/')) return script;
  return join(DATA_ROOT, script);
}

/**
 * Ejecuta todos los scripts configurados para un nombre de hook dado.
 *
 * @param {string} hookName - ej. 'before-scan', 'after-scan', 'before-evaluate', 'after-evaluate', 'after-tracker-add'
 * @param {object} [options]
 * @param {object} [options.env] - variables de entorno adicionales para el child process
 * @param {string[]} [options.args] - argumentos pasados a cada script de hook
 * @returns {Promise<{ran: number, errors: Array<{script, error}>}>}
 */
export async function runHooks(hookName, { env, args = [] } = {}) {
  const config = loadConfig();
  const scripts = config.hooks?.[hookName];
  if (!Array.isArray(scripts) || scripts.length === 0) {
    return { ran: 0, errors: [] };
  }

  const errors = [];
  let ran = 0;

  for (const script of scripts) {
    const abs = resolveScript(script);
    if (!existsSync(abs)) {
      errors.push({ script, error: 'archivo no encontrado' });
      continue;
    }
    try {
      execFileSync(process.execPath, [abs, ...args], {
        stdio: 'inherit',
        env: { ...process.env, ...env },
        timeout: 120_000,
        cwd: DATA_ROOT,
      });
      ran++;
    } catch (err) {
      errors.push({
        script,
        error: err.message || String(err),
      });
      console.warn(`⚠ hook "${hookName}" falló (${script}): ${err.message}`);
    }
  }

  return { ran, errors };
}
