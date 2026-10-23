// Independent fixed-input release-gate experiment. No model/network/browser calls.
// Do not rerun or relabel the older 11-observation fidelity diagnostic as gains.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as checks from '../lib/check.ts';
import { draftMessage } from '../lib/draft-message.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'output/iterations/parallel-fidelity-gate-20261022');
const sha = content => createHash('sha256').update(content).digest('hex');
const files = {
  oldR1: 'app/data/private/sessions/s-aa29a5ff-cad1-4625-921d-5485ccd18c93.json',
  ordinaryAdvice: 'app/data/private/sessions/s-31ac4656-5dc1-4585-9c30-9ae3d3620e72.json',
  newMiss: 'app/data/private/sessions/s-8c91f281-3ad7-4e9a-b9cc-02005bd0e87a.json',
};
const tracked = ['app/lib/check.ts', 'app/lib/draft-message.ts', 'app/app/api/export/route.ts', 'app/lib/agent.ts', 'app/lib/prompts.ts', 'app/lib/claim-review.ts', 'app/tests/parallel-fidelity-probe.live.mjs'];
await mkdir(output, { recursive: true });
const after = process.argv.includes('--after');
let batch;
if (!after) {
  batch = path.join(output, `batch-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(batch);
  const manifest = { protocol: 'fixed saved inputs; offline pure checks; no new model judgments; one release-policy layer', repeats: 1, liveCalls: 0, sourceHashes: {}, codeHashes: {}, labels: [
    { id: 'oldR1', target: '放进通勤包比多数轻薄本少一截负担', label: 'unsupported-already-detected-warn', expectedAfter: 'blocked', reason: 'Saved real reviewer explicitly found lack of comparison evidence.' },
    { id: 'ordinaryAdvice', label: 'ordinary-action-advice', expectedAfter: 'not-relabelled-by-text', reason: 'Keep existing review unchanged. Other saved evidence warnings can still block; do not count them as advice false positives.' },
    { id: 'newMiss', target: '通勤路上少压一点', label: 'unsupported-not-detected', expectedAfter: 'still-missed', reason: 'Only saved warning is format; gate cannot invent an unreported issue. Not a gate success.' },
    { id: 'adviceOnly', label: 'ordinary-action-advice', expectedAfter: 'pass', reason: 'Fixed saved R2 advice sentence with E170, no product-effect promise.' },
    { id: 'formatOnly', label: 'format-warn-only', expectedAfter: 'pass' },
    { id: 'nonFactWarns', label: 'image/model/price/promise-warning-controls', expectedAfter: 'pass', reason: 'Never promote every warning.' },
    { id: 'factMatrix', label: 'evidence/conflict/fabricated/absolute', expectedAfter: 'block' },
  ], success: 'Old R1 rejected at merge, summary and old-report export; fixed controls retain behavior; raw sample digests equal; new miss remains separately reported.', hypothesis: 'Only release policy changes; reviewer judgments, drafts and evidence stay fixed.' };
  for (const [id, name] of Object.entries(files)) {
    const raw = await readFile(path.join(root, name)); manifest.sourceHashes[name] = sha(raw);
    await writeFile(path.join(batch, `${id}.json`), raw, { flag: 'wx' });
  }
  for (const name of tracked) {
    const raw = await readFile(path.join(root, name)); manifest.codeHashes[name] = sha(raw);
    await writeFile(path.join(batch, name.replaceAll('/', '__')), raw, { flag: 'wx' });
  }
  const advice = 'HarmonyOS 6.1能不能跑你必用的软件，也要拿实际文件和账号试过。';
  await writeFile(path.join(batch, 'preregistered.json'), JSON.stringify({ ...manifest, fixedAdvice: advice }, null, 2), { flag: 'wx' });
} else {
  const dirs = (await readdir(output)).filter(name => name.startsWith('batch-')).sort();
  assert.ok(dirs.length, 'Must freeze baseline before implementation');
  batch = path.join(output, dirs.at(-1));
}
const manifest = JSON.parse(await readFile(path.join(batch, 'preregistered.json'), 'utf8'));
const corpus = {};
for (const [id, name] of Object.entries(files)) {
  const raw = await readFile(path.join(batch, `${id}.json`));
  assert.equal(sha(raw), manifest.sourceHashes[name], 'Frozen input hash must not change');
  corpus[id] = JSON.parse(raw);
}
const legacyBlocking = report => report.issues.some(issue => issue.severity === 'block');
const blocking = checks.hasBlockingIssues ?? legacyBlocking;
const publishable = checks.isPublishableReport ?? ((report, draft) => checks.isCheckCurrent(report, draft) && checks.hasCompleteClaimReview(report, draft) && report.status === 'pass' && !legacyBlocking(report));
const outcomes = [];
for (const [id, record] of Object.entries(corpus)) {
  const { draft, report, images } = record.session;
  const det = checks.runDeterministicChecks(draft, images);
  const ev = { ...report, issues: report.issues.filter(issue => issue.type !== 'format') };
  const merged = checks.mergeReports(det, ev);
  outcomes.push({ id, sourceStatus: report.status, sourceIssues: report.issues, merged, oldReportBlocked: blocking(report), oldReportPublishable: publishable(report, draft), message: draftMessage(draft, report), fullSessionFile: `${id}.json` });
}
const base = corpus.oldR1.session;
const format = base.report.issues.find(issue => issue.type === 'format');
const adviceDraft = { ...base.draft, title: '', lead: '', body: manifest.fixedAdvice, cta: '', tags: [], claims: [{ id: 'C1', text: manifest.fixedAdvice, factIds: ['catalog:096af0db608385d6f05408cc:E170'] }] };
assert.ok(corpus.ordinaryAdvice.session.draft.body.includes(adviceDraft.body));
const cleanReport = { ...base.report, issues: [], verifiedClaimIds: [], reviewedClaimIds: ['C1'] };
const adviceControls = [
  { id: 'adviceOnly', draft: adviceDraft, report: cleanReport },
  { id: 'formatOnly', draft: adviceDraft, report: { ...cleanReport, issues: [format] } },
  { id: 'nonFactWarns', draft: adviceDraft, report: { ...cleanReport, issues: ['image','model','price','promise'].map(type => ({ ...format, type })) } },
];
for (const row of adviceControls) outcomes.push({ ...row, publishable: publishable(row.report, row.draft), message: draftMessage(row.draft, row.report) });
const phase = after ? 'after' : 'baseline';
await writeFile(path.join(batch, `${phase}.json`), JSON.stringify({ phase, modelCalls: 0, outcomes }, null, 2), { flag: 'wx' });
if (!after) {
  assert.equal(outcomes.find(row => row.id === 'oldR1').oldReportPublishable, true);
  assert.equal(outcomes.find(row => row.id === 'newMiss').oldReportPublishable, true);
} else {
  assert.equal(outcomes.find(row => row.id === 'oldR1').oldReportPublishable, false);
  assert.equal(outcomes.find(row => row.id === 'oldR1').merged.status, 'needs_fix');
  assert.ok(!outcomes.find(row => row.id === 'oldR1').message.includes('写好了'));
  assert.equal(outcomes.find(row => row.id === 'newMiss').oldReportPublishable, true, 'Do not hide the separate verifier miss by changing its label or upgrading format warnings');
  for (const row of outcomes.filter(row => adviceControls.some(control => control.id === row.id))) assert.equal(row.publishable, true);
}
console.log(JSON.stringify({ phase, batch, oldR1Publishable: outcomes[0].oldReportPublishable, newSampleStillMissed: outcomes.find(row => row.id === 'newMiss').oldReportPublishable, modelCalls: 0 }));
