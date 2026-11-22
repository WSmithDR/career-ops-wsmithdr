import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, NODE } from './helpers.mjs';

function setup(formHtml, reportNum = '001') {
  const root = mkdtempSync(join(tmpdir(), 'apply-assist-'));
  mkdirSync(join(root, 'reports'), { recursive: true });
  mkdirSync(join(root, 'output'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'form.html'), formHtml);
  writeFileSync(join(root, 'reports', `${reportNum}-testco-role-2026-11-21.md`), `# ${reportNum} — TestCo — Engineer\n\n**Date:** 2026-11-21\n**URL:** file://${join(root, 'form.html')}\n**Score:** 4.0/5\n**Legitimacy:** Proceed\n**PDF:** ❌\n`);
  writeFileSync(join(root, 'config', 'profile.yml'), 'candidate:\n  full_name: Alex Example\n  email: alex@example.com\n');
  return root;
}

function runAssist(root, args, input = '') {
  return spawnSync(NODE, [join(ROOT, 'scripts/apply-assist.mjs'), ...args], {
    cwd: ROOT,
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: '' },
    input,
    encoding: 'utf8',
    timeout: 120000,
  });
}

function manifest(root, reportNum = '001') {
  return JSON.parse(readFileSync(join(root, 'output', 'applications', reportNum, 'manifest.json'), 'utf8'));
}

test('apply-assist is draft-only without explicit confirmation', () => {
  const root = setup(`<!doctype html><html><body><form id=f><label for=name>Full Name</label><input id=name name=name><label for=email>Email</label><input id=email name=email type=email><button id=submit type=submit>Submit</button></form><script>document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();document.body.dataset.sent='1';});</script></body></html>`);
  try {
    const r = runAssist(root, ['001', '--no-generate', '--no-open-draft'], 'NO\n');
    assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
    const m = manifest(root);
    assert.equal(m.finalStatus, 'draft-only-not-submitted');
    assert.equal(m.humanConfirmation.submittedByHuman, false);
    assert.equal(m.humanConfirmation.confirmed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply-assist submits only after exact SUBMIT confirmation', () => {
  const root = setup(`<!doctype html><html><body><form id=f><label for=name>Full Name</label><input id=name name=name><label for=email>Email</label><input id=email name=email type=email><button id=submit type=submit>Submit</button></form><script>document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();document.body.dataset.sent='1';});</script></body></html>`);
  try {
    const r = runAssist(root, ['001', '--no-generate', '--no-open-draft'], 'SUBMIT\n');
    assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
    const m = manifest(root);
    assert.equal(m.finalStatus, 'submitted-by-human-confirmation');
    assert.equal(m.humanConfirmation.confirmed, true);
    assert.equal(m.humanConfirmation.submittedByHuman, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply-assist --json returns ready-for-confirmation and never submits', () => {
  const root = setup(`<!doctype html><html><body><form><label for=name>Full Name</label><input id=name name=name><label for=email>Email</label><input id=email name=email type=email><button type=submit>Submit application</button></form></body></html>`);
  try {
    const r = runAssist(root, ['001', '--no-generate', '--no-open-draft', '--json']);
    assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
    const out = JSON.parse(r.stdout.match(/\{[\s\S]*\}\s*$/)[0]);
    assert.equal(out.phase, 'ready-for-confirmation');
    assert.equal(out.safety.safe, true);
    const m = manifest(root);
    assert.equal(m.finalStatus, 'ready-for-confirmation');
    assert.notEqual(m.humanConfirmation.submittedByHuman, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply-assist blocks when no submit control is detected', () => {
  const root = setup(`<!doctype html><html><body><form><label for=name>Full Name</label><input id=name name=name><label for=email>Email</label><input id=email name=email type=email></form></body></html>`);
  try {
    const r = runAssist(root, ['001', '--no-generate', '--no-open-draft', '--json']);
    assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
    const out = JSON.parse(r.stdout.match(/\{[\s\S]*\}\s*$/)[0]);
    assert.equal(out.phase, 'blocked-for-safety');
    assert.ok(out.safety.reasons.includes('submit-not-found'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply-assist blocks when required fields remain unfilled', () => {
  const root = setup(`<!doctype html><html><body><form><label for=name>Full Name</label><input id=name name=name><label for=email>Email</label><input id=email name=email type=email><label for=cover>Cover Letter</label><textarea id=cover name=cover required></textarea><button type=submit>Submit</button></form></body></html>`);
  try {
    const r = runAssist(root, ['001', '--no-generate', '--no-open-draft', '--json']);
    assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
    const out = JSON.parse(r.stdout.match(/\{[\s\S]*\}\s*$/)[0]);
    assert.equal(out.phase, 'blocked-for-safety');
    assert.ok(out.safety.reasons.includes('required-fields-unfilled'));
    assert.ok(out.requiredMissing.some((f) => /cover/i.test(f.label)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply-assist blocks multi-step/next controls by default', () => {
  const root = setup(`<!doctype html><html><body><form><label for=name>Full Name</label><input id=name name=name><label for=email>Email</label><input id=email name=email type=email><button type=button>Next</button><button type=submit>Submit</button></form></body></html>`);
  try {
    const r = runAssist(root, ['001', '--no-generate', '--no-open-draft', '--json']);
    assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
    const out = JSON.parse(r.stdout.match(/\{[\s\S]*\}\s*$/)[0]);
    assert.equal(out.phase, 'blocked-for-safety');
    assert.ok(out.safety.reasons.includes('multi-step-or-next-control-detected'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
