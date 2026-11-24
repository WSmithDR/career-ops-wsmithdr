#!/usr/bin/env node
/**
 * scripts/install-automation.mjs — Hook de inicio de sesión: instala las
 * automatizaciones de career-ops si faltan.
 *
 * Gestiona las tres vías de programación en paralelo:
  *   1. crontab clásico (automation/ — 7 jobs: anki, scan, triage, recheck, harvest,

 *      selftest, heartbeat) con paths corregidos al repo real.
 *   2. crontab de auto-run (scripts/auto-run.mjs, cada 6 horas).
 *   3. timer de systemd (config/career-ops-scan.service + .timer).
 *
 * Es idempotente: solo escribe lo que falta y nunca duplica entradas.
 * Se invoca desde .bashrc / .zshrc / .profile al iniciar sesión.
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const REPO = process.env.CAREER_OPS_ROOT ||
  (() => {
    try {
      return execSync('git rev-parse --show-toplevel', {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd(),
      }).toString().trim();
    } catch { return process.cwd(); }
  })();

const STATE_FILE = join(REPO, 'data', 'automation-installed.json');
const AUTO_DIR = join(REPO, 'automation');
const CONFIG_DIR = join(REPO, 'config');
const SCRIPTS_DIR = join(REPO, 'scripts');

let changed = false;
const actions = [];

function sh(cmd, opts = {}) {
  try {
    return execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'], ...opts }).toString().trim();
  } catch (e) {
    return '';
  }
}

function crontabList() { return sh('crontab -l 2>/dev/null'); }
function crontabInstall(content) {
  const tmp = join(REPO, 'data', '.crontab-next');
  writeFileSync(tmp, content, 'utf-8');
  execFileSync('crontab', [tmp], { stdio: 'pipe' });
  return true;
}

function hasCrontabEntry(needle) {
  return crontabList().includes(needle);
}

function systemdActive(unit) {
  return sh(`systemctl is-enabled ${unit} 2>/dev/null || systemctl is-active ${unit} 2>/dev/null`).includes('active') ||
    sh(`systemctl is-enabled ${unit} 2>/dev/null`).includes('enabled');
}

// ── 1. crontab clásico (automation/) ──────────────────────────────────

const CRON_JOBS = [
  { name: 'anki',    dow: '1-5', h: '7',  m: '5',  wrapper: 'career-anki',   args: '' },
  { name: 'scan',    dow: '1-5', h: '7',  m: '17', wrapper: 'career-scan',    args: '--quiet' },
  { name: 'triage',  dow: '1-5', h: '7',  m: '41', wrapper: 'career-triage',  args: '' },
  { name: 'recheck', dow: '1',   h: '8',  m: '12', wrapper: 'career-recheck', args: '7' },
  { name: 'harvest', dow: '1',   h: '8',  m: '46', wrapper: 'career-harvest', args: '' },
  { name: 'selftest',dow: '1',   h: '9',  m: '3',  wrapper: 'career-selftest',args: '' },
  { name: 'heartbeat',dow:'1-5', h: '9',  m: '30', wrapper: 'heartbeat',      args: '' },
];

const envLine = `CAREER_OPS_ROOT=${REPO}`;
const cronHeader = `# career-ops automation — installed by scripts/install-automation.mjs\n# Repo: ${REPO}\nCAREER_OPS_ROOT=${REPO}\nPATH=/usr/local/bin:/usr/bin:/bin\n\n`;

let cronBody = cronHeader;
for (const j of CRON_JOBS) {
  cronBody += `# ${j.name} — ${j.h}:${String(j.m).padStart(2,'0')} ${j.dow === '1-5' ? 'Mon–Fri' : 'Mon'}\n`;
  cronBody += `${j.m} ${j.h} * * ${j.dow} . "${AUTO_DIR}/automation.env" && "${AUTO_DIR}/run-job" ${j.name} "${AUTO_DIR}/${j.wrapper}" ${j.args}\n\n`;
}

const cronMarker = 'career-ops automation — installed by scripts/install-automation.mjs';
const cronHasMarker = crontabList().includes(cronMarker);

if (!cronHasMarker) {
  let current = crontabList();
  // Quitar bloques previos de career-ops (por si los paths apuntaban a otro repo)
  current = current.replace(/# career-ops job search automation[\s\S]*?(?=\n# |\n$)/g, '').trim();
  current = current.replace(/# career-ops automation[\s\S]*?(?=\n# |\n$)/g, '').trim();
  const next = (current ? current + '\n\n' : '') + cronBody;
  crontabInstall(next);
  changed = true;
  actions.push('crontab clásico (7 jobs) instalado con paths del repo real');
} else {
  actions.push('crontab clásico ya instalado');
}

// ── 2. crontab de auto-run (cada 6 horas) ─────────────────────────────

const autorunMarker = 'career-ops auto-run — every 6 hours';
const autorunHas = crontabList().includes(autorunMarker);

if (!autorunHas) {
  let current = crontabList();
  current = current.replace(/# career-ops auto-run[\s\S]*?(?=\n# |\n$)/g, '').trim();
  const autorunBlock = `# career-ops auto-run — every 6 hours\n0 */6 * * * /usr/bin/node ${SCRIPTS_DIR}/auto-run.mjs >> ${join(REPO, 'data', 'auto-run.log')} 2>&1\n`;
  const next = (current ? current + '\n\n' : '') + autorunBlock;
  crontabInstall(next);
  changed = true;
  actions.push('crontab auto-run (cada 6 h) instalado');
} else {
  actions.push('crontab auto-run ya instalado');
}

// ── 3. timer de systemd (solo detección, nunca instala con sudo aquí) ───

const svcSrc = join(CONFIG_DIR, 'career-ops-scan.service');
const tmrSrc = join(CONFIG_DIR, 'career-ops-scan.timer');

let systemdInstalled = false;
if (existsSync(svcSrc) && existsSync(tmrSrc) && sh('which systemctl 2>/dev/null')) {
  const already = sh(`systemctl list-unit-files 2>/dev/null | grep -q career-ops-scan`);
  if (already) {
    actions.push('timer de systemd ya instalado');
    systemdInstalled = true;
  } else {
    actions.push('timer de systemd disponible (instalar manualmente con sudo)');
  }
} else {
  actions.push('timer de systemd: omitido (no hay systemd o faltan archivos de unidad)');
}

// ── Estado ────────────────────────────────────────────────────────────

const state = {
  installedAt: new Date().toISOString(),
  repo: REPO,
  changed,
  crontabClassic: cronHasMarker || changed,
  crontabAutoRun: autorunHas || changed,
  systemdTimer: systemdInstalled,
  actions,
};
mkdirSync(join(REPO, 'data'), { recursive: true });
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');

if (changed) {
  console.log('🔧 career-ops automatizaciones instaladas:');
  for (const a of actions) console.log(`   • ${a}`);
} else {
  console.log('✅ career-ops automatizaciones ya instaladas (nada que hacer).');
}
