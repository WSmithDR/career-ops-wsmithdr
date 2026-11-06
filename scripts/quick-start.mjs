#!/usr/bin/env node
/**
 * quick-start.mjs — valida que el entorno esté listo para usar career-ops.
 *
 * Evalúa:
 *   1. pnpm instalado y dependencias instaladas (node_modules presente).
 *   2. doctor.mjs pasa (Node, deps, Playwright, cv.md, config, portals, etc.).
 *   3. portals.yml válido y con al menos una entrada con provider.
 *   4. .opencode/commands/career-ops-apply.md presente.
 *   5. scripts/apply.mjs y scripts/apply-pipeline.mjs presentes.
 *
 * Uso:
 *   node scripts/quick-start.mjs
 *   pnpm run quick-start
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

let errors = 0;
let warns = 0;

function check(label, fn) {
  try {
    const ok = fn();
    if (ok) {
      console.log(`  ✅ ${label}`);
    } else {
      console.log(`  ❌ ${label}`);
      errors++;
    }
  } catch (e) {
    console.log(`  ❌ ${label} — ${String(e.message).slice(0, 120)}`);
    errors++;
  }
}

function warn(label, fn) {
  try {
    const ok = fn();
    if (!ok) {
      console.log(`  ⚠️  ${label}`);
      warns++;
    }
  } catch {
    console.log(`  ⚠️  ${label}`);
    warns++;
  }
}

console.log('┌── quick-start ───────────────────────────────────────────────┐');
console.log('│ Validando entorno de career-ops-wsmithdr                     │');
console.log('└──────────────────────────────────────────────────────────────┘\n');

console.log('1) Dependencias:');
check('pnpm instalado', () => {
  try { execFileSync('pnpm', ['--version'], { stdio: 'pipe', encoding: 'utf8' }); return true; } catch { return false; }
});
check('node_modules instalado', () => existsSync(join(REPO, 'node_modules')));
check('Playwright Chromium instalado', () => {
  try {
    execFileSync('node', ['-e', "require('playwright').chromium.executablePath()"], { stdio: 'pipe', cwd: REPO });
    return true;
  } catch { return false; }
});

console.log('\n2) Doctor:');
try {
  const out = execFileSync('node', ['doctor.mjs'], { cwd: REPO, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const passed = out.includes('Result: All checks passed');
  if (passed) console.log('  ✅ doctor.mjs — todo OK');
  else {
    console.log('  ⚠️  doctor.mjs — tiene warnings (revisar salida arriba)');
    warns++;
  }
} catch (e) {
  console.log(`  ❌ doctor.mjs falló — ${String(e.stderr || e.message).slice(0, 200)}`);
  errors++;
}

console.log('\n3) Configuración:');
check('portals.yml válido', () => {
  try {
    execFileSync('node', ['validate-portals.mjs', 'portals.yml'], { cwd: REPO, stdio: 'pipe', encoding: 'utf8' });
    return true;
  } catch { return false; }
});
check('Comando /apply (OpenCode)', () => existsSync(join(REPO, '.opencode', 'commands', 'career-ops-apply.md')));
check('Comando /apply (Claude Code)', () => existsSync(join(REPO, '.claude', 'commands', 'apply.md')));
check('Comando /apply (Codex)', () => existsSync(join(REPO, '.codex', 'commands', 'apply.md')));
check('Comando /apply (Pi)', () => existsSync(join(REPO, '.pi', 'commands', 'apply.md')));
check('Comando /apply (Agy)', () => existsSync(join(REPO, '.antigravitycli', 'commands', 'apply.md')));
check('scripts/apply.mjs', () => existsSync(join(REPO, 'scripts', 'apply.mjs')));
check('scripts/apply-pipeline.mjs', () => existsSync(join(REPO, 'scripts', 'apply-pipeline.mjs')));

console.log('\n4) Datos de usuario:');
check('cv.md presente', () => existsSync(join(REPO, 'cv.md')));
check('config/profile.yml presente', () => existsSync(join(REPO, 'config', 'profile.yml')));
check('modes/_profile.md presente', () => existsSync(join(REPO, 'modes', '_profile.md')));

console.log(`\n┌── Resultado ─────────────────────────────────────────────────┐`);
console.log(`│ ${errors === 0 ? '✅ Todo OK' : `❌ ${errors} error(es)`}  │ ${warns > 0 ? `⚠️  ${warns} aviso(s)` : ''} │`);
console.log('└──────────────────────────────────────────────────────────────┘\n');

if (errors > 0) {
  console.log('Corrige los errores anteriores antes de usar /apply o apply-pipeline.');
  process.exit(1);
} else if (warns > 0) {
  console.log('Listo para usar, aunque hay avisos no críticos.');
  process.exit(0);
} else {
  console.log('¡Listo! Usa:');
  console.log('  /apply <url>           (en cualquier CLI soportada)');
  console.log('  /apply-pipeline        (prepara todas las ofertas pendientes)');
  console.log('  pnpm run quick-start   (volver a verificar en cualquier momento)');
  process.exit(0);
}
