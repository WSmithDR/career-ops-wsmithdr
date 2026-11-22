/**
 * lib/apply-trace.mjs — contrato canónico de trazabilidad de borrador/envío.
 *
 * Un único registro por aplicación, escrito en output/applications/{NNN}/manifest.json,
 * compartido entre el CLI (apply-assist), el bot Telegram y la web UI. Nunca
 * auto-submite: solo registra lo que el humano confirmó y, opcionalmente, el
 * submit click verificado.
 *
 * Contrato (campos del manifest):
 *   humanConfirmation.source        'telegram' | 'cli' | 'web' | 'unknown'
 *   humanConfirmation.timestamp     ISO-8601 del momento del registro
 *   humanConfirmation.draftPrepared boolean, cuándo se preparó el borrador
 *   humanConfirmation.confirmed     boolean, el humano escribió SUBMIT
 *   humanConfirmation.submittedByHuman boolean, click de submit ejecutado
 *   humanConfirmation.submittedAt   ISO-8601 del click de submit (si aplica)
 *   humanConfirmation.finalUrl      URL final tras submit (si aplica)
 *   tracker.status                  'Applied' | 'Evaluated' | 'blocked-for-safety' | ...
 *   tracker.note                    nota canónica para set-status.mjs --note
 *   timeline[].event / [].at / [].source hitos con fuente y marca temporal
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SOURCES = new Set(['telegram', 'cli', 'web', 'unknown']);

function nowIso() { return new Date().toISOString(); }
function today() { return new Date().toISOString().slice(0, 10); }

export function normalizeSource(s) {
  s = String(s || '').toLowerCase().trim();
  return SOURCES.has(s) ? s : 'unknown';
}

/**
 * Escribe/fusiona un registro de trazabilidad en el manifest de una aplicación.
 * Idempotente: llamadas sucesivas acumulan hits de timeline y preservan campos
 * previos no sobrescritos por el parche.
 *
 * @param {string} manifestPath
 * @param {object} patch
 *   patch.source            'telegram' | 'cli' | 'web' (obligatorio)
 *   patch.event             nombre del hito de timeline (obligatorio)
 *   patch.draftPrepared     boolean
 *   patch.confirmed         boolean
 *   patch.submittedByHuman  boolean
 *   patch.submittedAt       ISO string (override del ahora)
 *   patch.finalUrl          string
 *   patch.verified          boolean — evidencia verificada de submit en manifest
 *   patch.tracker           { status, note, on } — nota para set-status.mjs
 * @returns {object} el manifest resultante
 */
export function writeTraceRecord(manifestPath, patch = {}) {
  const source = normalizeSource(patch.source);
  if (!patch.event) throw new Error('writeTraceRecord: patch.event es obligatorio');

  let current = {};
  if (existsSync(manifestPath)) {
    try { current = JSON.parse(readFileSync(manifestPath, 'utf-8')); } catch {}
  }

  const at = patch.timestamp || nowIso();
  const hc = {
    ...(current.humanConfirmation || {}),
    source,
    timestamp: at,
    ...(patch.draftPrepared !== undefined ? { draftPrepared: patch.draftPrepared } : {}),
    ...(patch.confirmed !== undefined ? { confirmed: patch.confirmed } : {}),
    ...(patch.submittedByHuman !== undefined ? { submittedByHuman: patch.submittedByHuman } : {}),
    ...(patch.submittedAt ? { submittedAt: patch.submittedAt } : {}),
    ...(patch.finalUrl ? { finalUrl: patch.finalUrl } : {}),
    ...(patch.verified !== undefined ? { verifiedSubmitEvidence: patch.verified } : {}),
  };

  const timelineEntry = {
    at,
    source,
    event: patch.event,
    ...(patch.details ? { details: patch.details } : {}),
  };

  const next = {
    ...current,
    ...patch,
    humanConfirmation: hc,
    timeline: [...(Array.isArray(current.timeline) ? current.timeline : []), timelineEntry],
    updatedAt: at,
  };

  // Elimina claves de parche que no pertenecen al nivel raíz del manifest.
  delete next.source;
  delete next.event;
  delete next.details;
  delete next.draftPrepared;
  delete next.confirmed;
  delete next.submittedByHuman;
  delete next.submittedAt;
  delete next.finalUrl;
  delete next.verified;
  delete next.tracker;

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  return { manifest: next, tracker: patch.tracker || null };
}

/**
 * Devuelve true si el manifest contiene evidencia verificada de que un humano
 * ejecutó el click de submit (no solo reportó haber enviado).
 */
export function isVerifiedSubmit(manifest) {
  if (!manifest) return false;
  const hc = manifest.humanConfirmation || {};
  return Boolean(hc.submittedByHuman === true || manifest.finalStatus === 'submitted-by-human-confirmation');
}

/**
 * Construye la nota canónica para el tracker (set-status.mjs --note) y el
 * estado a registrar, según si hay evidencia verificada de submit.
 *
 * @param {string} source 'telegram' | 'cli' | 'web'
 * @param {boolean} verifiedSubmitEvidence
 * @param {string} [day] YYYY-MM-DD (default hoy)
 * @returns {{ status: 'Applied'|'Evaluated', note: string, on: string }}
 */
export function trackerDecision(source, verifiedSubmitEvidence, day = today()) {
  const s = normalizeSource(source);
  if (verifiedSubmitEvidence) {
    return {
      status: 'Applied',
      note: `human-send: sent ${day} source=${s} verified-manifest`,
      on: day,
    };
  }
  return {
    status: 'Evaluated',
    note: `human-send: reported-sent-unverified ${day} source=${s}`,
    on: day,
  };
}

export { SOURCES };
