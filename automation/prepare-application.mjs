#!/usr/bin/env node
/**
 * prepare-application.mjs — ensambla todo lo listo para aplicar a una vacante.
 *
 * Para un número de reporte (o URL) dado:
 *   1. Resuelve el reporte en reports/ (vía find.mjs si se pasa una URL).
 *   2. Extrae empresa, rol, URL, fecha, score y legitimidad del reporte.
 *   3. Genera la carta de presentación (generate-cover-letter.mjs --payload).
 *   4. Escribe un borrador de correo (.eml) y un enlace mailto: listo para
 *      abrir en tu cliente de correo.
 *   5. Marca el CV adaptado como pendiente (generar vía /career-ops pdf).
 *
 * Diseño: solo escribe borradores locales en output/applications/{NNN}/.
 * NUNCA envía correos, nunca rellena formularios, nunca hace Submit. Tú
 * revisas el borrador y tú das clic en Enviar.
 *
 * Uso:
 *   node automation/prepare-application.mjs <numero-de-reporte|url>
 *   node automation/prepare-application.mjs 002
 *   node automation/prepare-application.mjs https://empresa.com/jobs/123
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const OUTPUT = join(REPO, 'output', 'applications');

const REPORT_ARG = process.argv[2];
if (!REPORT_ARG) {
  console.error('Uso: node automation/prepare-application.mjs <numero-de-reporte|url>');
  process.exit(64);
}

/** Ejecuta un comando del repo y devuelve su stdout (trimado). */
function repoNode(script, ...args) {
  const full = [script, ...args].filter(Boolean);
  try {
    return execFileSync('node', full, { cwd: REPO, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
  } catch (e) {
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    const msg = stderr || String(e.message || e).trim();
    throw new Error(`prepare-application: \`node ${full.join(' ')}\` falló\n${msg}`);
  }
}

/** Resuelve el número de reporte canónico (0-padded, 3 dígitos). */
function resolveReportNumber(arg) {
  // Si ya parece un número (042 o 42)
  if (!isNaN(Number(arg)) && arg.trim() === String(Number(arg))) {
    return String(Number(arg)).padStart(3, '0');
  }

  // Si es una URL, usar find.mjs para buscar el reporte asociado
  try {
    const out = repoNode('find.mjs', arg);
    const m = out.match(/^(\d{3})\s*->\s*/m) || out.match(/(\d{3})/);
    if (m) return m[1].padStart(3, '0');
    throw new Error(`find.mjs no devolvió un número de reporte para: ${arg}\n${out}`);
  } catch (e) {
    // Fallback: buscar directamente en reports/ por coincidencia de URL en el contenido
    const reportsDir = join(REPO, 'reports');
    if (!existsSync(reportsDir)) throw e;
    const files = readdirSync(reportsDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const content = readFileSync(join(reportsDir, f), 'utf8');
      if (content.includes(arg)) {
        const n = f.match(/^(\d{3})-/);
        if (n) return n[1];
      }
    }
    throw e;
  }
}

/** Busca el archivo de reporte por número. */
function findReportFile(num) {
  const reportsDir = join(REPO, 'reports');
  if (!existsSync(reportsDir)) return null;
  const files = readdirSync(reportsDir).filter(f => f.startsWith(`${num}-`) && f.endsWith('.md'));
  return files.length ? join(reportsDir, files[0]) : null;
}

/** Extrae campos clave del reporte. */
function parseReport(content) {
  const g = (re) => {
    const m = content.match(re);
    return m ? m[1].trim() : '';
  };

  // Título del reporte: "# 002 — Niuro — Forward Deployed Engineer"
  const headerMatch = content.match(/^#\s*\d{3}\s*—\s*([^—]+)\s*—\s*(.+)/m);
  let company = '', role = '';
  if (headerMatch) {
    company = headerMatch[1].trim();
    role = headerMatch[2].trim();
  }

  const score = g(/\*\*Score:\*\*\s*([^\n]+)/im);
  const url = g(/\*\*URL:\*\*\s*(\S+)/im);
  const legitimacy = g(/\*\*Legitimacy:\*\*\s*([^\n]+)/im);
  const date = g(/\*\*Date:\*\*\s*([^\n]+)/im);
  const pdf = g(/\*\*PDF:\*\*\s*([^\n]+)/im);

  return { company, role, score, url, legitimacy, date, pdf };
}

/** Genera la carta de presentación vía generate-cover-letter.mjs --payload. */
function generateCoverLetter() {
  try {
    repoNode('generate-cover-letter.mjs', '--payload');
    return true;
  } catch (e) {
    return false;
  }
}

/** Construye el borrador de correo (.eml + mailto + resumen). */
function composeEmailDraft(reportNum, reportPath, report, clOk) {
  const dir = join(OUTPUT, reportNum);
  mkdirSync(dir, { recursive: true });

  const subject = `Aplicación: ${report.role || 'Vacante'} — ${report.company || 'Empresa'}`;
  const body = `Hola,\n\nAdjunto mi CV adaptado y carta de presentación para la vacante de ${report.role || ''} en ${report.company || ''}.\n\nVacante: ${report.url || '—'}\nReporte: ${reportPath.split('/').pop()}\nScore: ${report.score || '—'}/5 | Legitimidad: ${report.legitimacy || '—'}\n\nQuedo atento a sus comentarios.\n\nSaludos,\nWagner Dueñas\n+593 989 785 480\nwsmithdrdev@gmail.com\ngithub.com/WSmithDR\n`;

  const eml = [
    `From: "Wagner Dueñas" <wsmithdrdev@gmail.com>`,
    `To: `,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="utf-8"`,
    ``,
    body,
  ].join('\n');

  const emlPath = join(dir, `borrador-${reportNum}.eml`);
  writeFileSync(emlPath, eml);

  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const mailtoPath = join(dir, `mailto-${reportNum}.txt`);
  writeFileSync(mailtoPath, mailto + '\n');

  const summary = [
    `# Borrador listo para revisar — reporte ${reportNum}`,
    '',
    `- Empresa: ${report.company || '—'}`,
    `- Rol: ${report.role || '—'}`,
    `- URL vacante: ${report.url || '—'}`,
    `- Fecha: ${report.date || '—'}`,
    `- Legitimidad: ${report.legitimacy || '—'}`,
    `- Score: ${report.score || '—'}`,
    `- PDF del reporte: ${report.pdf || '—'}`,
    `- Carta de presentación: ${clOk ? 'generada' : 'pendiente (revisar output/)'}`,
    `- CV adaptado (PDF): pendiente — ejecute /career-ops pdf en su AI CLI`,
    '',
    '## Archivos generados:',
    `- ${emlPath}`,
    `- ${mailtoPath}`,
    '',
    '## Pasos siguientes (tú los ejecutas):',
    '1. Abre el archivo .eml en tu cliente de correo (o copia el enlace mailto:).',
    '2. Rellena el destinatario (To).',
    '3. Adjunta el CV PDF y la carta de presentación de output/.',
    '4. Revisa el cuerpo del correo y envía tú mismo.',
    '',
    '⚠ Este script solo prepara borradores. Nunca envía correos ni rellena formularios.',
  ].join('\n');

  const summaryPath = join(dir, `README-preparacion-${reportNum}.md`);
  writeFileSync(summaryPath, summary);

  return { dir, emlPath, mailtoPath, summaryPath };
}

/** Intenta abrir el mailto: en el navegador/cliente por defecto. */
function openDraft(mailtoPath) {
  try {
    const mailto = readFileSync(mailtoPath, 'utf8').trim();
    if (process.platform === 'linux') {
      spawnSync('xdg-open', [mailto], { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      spawnSync('open', [mailto], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      spawnSync('cmd', ['/c', 'start', '', mailto], { stdio: 'ignore' });
    }
  } catch { /* no bloquear si no se puede abrir */ }
}

// ── main ──────────────────────────────────────────────────────────────

const num = resolveReportNumber(REPORT_ARG);
const reportPath = findReportFile(num);

if (!reportPath || !existsSync(reportPath)) {
  console.error(`prepare-application: no se encontró el reporte para "${num}" en reports/`);
  process.exit(1);
}

const content = readFileSync(reportPath, 'utf8');
const report = parseReport(content);

console.log(`prepare-application: reporte ${num} — ${report.company || '—'} | ${report.role || '—'}`);

let clOk = false;
try { clOk = generateCoverLetter(); } catch { /* ignorar */ }

const { dir, emlPath, mailtoPath, summaryPath } = composeEmailDraft(num, reportPath, report, clOk);

console.log(`prepare-application: borrador escrito en ${dir}`);
console.log(`prepare-application: ${emlPath}`);
console.log(`prepare-application: ${mailtoPath}`);
console.log('');
console.log(readFileSync(summaryPath, 'utf8'));

openDraft(mailtoPath);
