// Task B: saved evidence + offline production checks only. No model, HTTP or browser calls.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDeterministicChecks, mergeReports, hasCompleteClaimReview, isCheckCurrent } from '../lib/check.ts';
import { parseClaimReview, unreviewedClaims } from '../lib/claim-review.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'output/iterations/parallel-fidelity-20261022');
const sha = data => createHash('sha256').update(data).digest('hex');
const read = name => readFile(path.join(root, name));
await mkdir(out, { recursive: true });
const run = path.join(out, `offline-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(run); // Every attempt preserves earlier evidence, including failed assertions.
const save = (name, value) => writeFile(path.join(run, name), JSON.stringify(value, null, 2), { flag: 'wx' });
const actualFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network forbidden in this offline probe'); };
const protectedFiles = ['app/lib/check.ts', 'app/lib/claim-review.ts', 'app/lib/agent.ts', 'app/lib/prompts.ts', 'app/app/api/export/route.ts', 'app/tests/body-range-repair.live.mjs', 'app/tests/claim-review-fixture.ts'];
const before = {};
for (const name of protectedFiles) {
  const content = await read(name);
  before[name] = sha(content);
  await writeFile(path.join(run, name.replaceAll('/', '__')), content, { flag: 'wx' });
}
const historicalFiles = ['output/iterations/user-hybrid-length-fixed-20261021/results.json', 'output/iterations/user-body-range-repair-final-20261021/results.json'];
const historical = [];
for (const name of historicalFiles) {
  const content = await read(name);
  historical.push(JSON.parse(content));
  before[name] = sha(content);
  await writeFile(path.join(run, name.split('/').at(-2) + '.json'), content, { flag: 'wx' });
}
const saved = [];
for (const item of historical[0].results) {
  const name = `app/data/private/sessions/${item.sessionId}.json`;
  const content = await read(name);
  const session = JSON.parse(content).session;
  before[name] = sha(content);
  assert.deepEqual(session.draft, item.draft, 'Persisted execution input must match historical final draft');
  assert.deepEqual(session.report, item.events.findLast(event => event.type === 'check').report);
  // Full execution session, including evidence metadata/images/web pages; never toView().
  await save(`session-R${item.round}.json`, { source: name, sourceSha256: sha(content), session });
  saved.push({ round: item.round, sessionId: item.sessionId, session });
}
const base = saved[0].session;
const weight = base.evidence.find(row => row.id === 'catalog:096af0db608385d6f05408cc:E16');
assert.ok(weight);
const comparison = '放进通勤包比多数轻薄本少一截负担';
const sensory = '地铁换乘、步行到公司这段路少一点坠肩感';
const fixtureBody = historical[1].results[2].body;
const positive = '标准屏版标称重量为798 g，实际重量依配置、制造工艺、测量方法的不同可能有所差异。';
const advice = '建议拿整套装备比较重量，再决定是否适合自己的通勤路线。';
const labels = [
  { id: 'N1-natural-R1', text: comparison, expected: 'must-block', basis: 'No comparison population or carrying-sensation study in saved 210 evidence units; historical reviewer explicitly agrees.' },
  { id: 'N2-length-R3-comparison', text: '放进通勤包比多数办公本轻一截', expected: 'unsupported', basis: 'No office-laptop population or sampling definition; fixture verifier, not natural model verification.' },
  { id: 'N3-length-R3-sensation', text: sensory, expected: 'unsupported', basis: 'Single device weight is not a study of carrying sensation; fixture verifier.' },
  { id: 'P1-weight', text: positive, expected: 'supported', basis: 'Exact E16 + E20 with version and measurement conditions.' },
  { id: 'P2-action', text: advice, expected: 'advice', basis: 'Asks user to compare; makes no product result or subjective-effect assertion.' },
  { id: 'P3-natural-R2', text: saved[1].session.draft.body, expected: 'no-target-comparison-or-sensation', basis: 'Do not relabel software/port confirmation advice as a measured product effect.' },
  { id: 'P4-natural-R3', text: saved[2].session.draft.body, expected: 'no-target-comparison-or-sensation', basis: '这个数字比屏幕参数更直接 is an editorial decision preference, not a comparative weight/sensation measurement.' },
];
await save('preregistered.json', {
  method: 'offline only; original samples unchanged; no production edits; no paid model checks; no config access',
  labels, inputHash: sha(JSON.stringify(labels)), sourceHashes: before,
  repeats: 1, liveCalls: 0,
  hypothesis: 'At the final report merge layer, an already-detected unsupported comparison escapes because warn is accepted as non-blocking. Hold draft, evidence, reviewer text and all other decisions fixed; change only this issue severity to block.',
  falsification: 'If exact original replay does not pass or changing only target severity to block does not stop pass, reject the hypothesis for this sample.',
  successCriteria: 'Preserve full drafts/evidence/reports; match saved pass and target warn exactly; demonstrate isolated severity counterfactual; preserve positive controls. Assertions validate diagnosis, not factual quality improvement.',
  limitations: 'Counterfactuals and malformed-judge fixtures are offline protocol demonstrations, not fresh model behavior or production fixes.'
});

const results = [];
try {
  for (const item of saved) {
    const { draft, evidence, images, report } = item.session;
    const det = runDeterministicChecks(draft, images);
    // Reconstruct verifier-shaped reply from saved merged report. Not raw model text.
    const ev = { status: report.status, issues: report.issues.filter(issue => issue.type !== 'format'), verifiedClaimIds: report.verifiedClaimIds, reviewedClaimIds: report.reviewedClaimIds, verifiedImageIds: [] };
    const replay = mergeReports(det, ev);
    assert.equal(replay.status, report.status);
    assert.deepEqual(replay.issues, report.issues);
    const exportTextGuards = isCheckCurrent(replay, draft) && hasCompleteClaimReview(replay, draft) && !replay.issues.some(issue => issue.severity === 'block') && replay.status === 'pass';
    results.push({ id: `saved-R${item.round}`, replay, exportTextGuards, caveat: 'Same pure text guards as export route; no HTTP export, image-file read or browser action performed.' });
  }
  const { draft, report, images } = base;
  const bad = report.issues.find(issue => issue.text === comparison);
  assert.equal(bad.severity, 'warn');
  assert.ok(!draft.claims.some(claim => claim.text.includes(comparison)));
  const evChanged = { ...report, issues: report.issues.filter(issue => issue.type !== 'format').map(issue => issue === bad ? { ...issue, severity: 'block' } : issue) };
  const counterfactual = mergeReports(runDeterministicChecks(draft, images), evChanged);
  assert.equal(counterfactual.status, 'needs_fix');
  results.push({ id: 'single-severity-counterfactual', onlyChanged: `${comparison}: warn -> block`, report: counterfactual, hypothesisSupportedForThisSavedSample: true });

  // Coverage only knows writer-registered IDs. These functions cannot discover omitted sentences.
  const noIssueReply = { issues: [], verifiedClaimIds: draft.claims.map(claim => claim.id), reviewedClaimIds: draft.claims.map(claim => claim.id), verifiedImageIds: [] };
  const omission = mergeReports(runDeterministicChecks(draft, images), noIssueReply);
  assert.equal(omission.status, 'pass');
  assert.equal(unreviewedClaims(draft.claims, noIssueReply.verifiedClaimIds, []).length, 0);
  assert.equal(hasCompleteClaimReview(omission, draft), true);
  results.push({ id: 'omitted-sentence-coverage', method: 'constructed incorrect reviewer reply, not observed historical reply', fullDraft: draft, reply: noIssueReply, report: omission, target: comparison, conclusion: 'Coverage of registered IDs is not coverage of published sentences.' });

  // Structural parser validates IDs, not semantic entailment. Wrong judgments here are deliberate inputs.
  for (const [id, text, verdict, evidence_ids] of [
    ['parser-wrong-supported', comparison, 'supported', [weight.id]],
    ['parser-wrong-advice', sensory, 'advice', []],
    ['parser-correct-supported', positive, 'supported', [weight.id, 'catalog:096af0db608385d6f05408cc:E20']],
    ['parser-correct-advice', advice, 'advice', []],
  ]) {
    const claims = [{ id: 'C1', text, factIds: [weight.id, 'catalog:096af0db608385d6f05408cc:E20'] }];
    const reply = { claim_checks: [{ id: 'C1', verdict, evidence_ids, reason: id.startsWith('parser-wrong') ? 'Deliberately wrong offline judge fixture' : 'Fixed positive control' }], issues: [] };
    const parsed = parseClaimReview(reply, claims, base.evidence);
    assert.equal(parsed.issues.length, 0);
    results.push({ id, claims, reply, parsed, method: 'structural acceptance only; no model-quality claim' });
  }
  const tagDraft = { ...draft, body: positive, tags: ['背一天不累'], claims: [{ id: 'C1', text: positive, factIds: [weight.id, 'catalog:096af0db608385d6f05408cc:E20'] }] };
  const tagCheck = runDeterministicChecks(tagDraft, images);
  assert.ok(!tagCheck.issues.some(issue => issue.text.includes('背一天不累')));
  results.push({ id: 'tag-surface-gap', draft: tagDraft, report: tagCheck, method: 'constructed counterexample; static verifyEvidence prompt omits tags, despite published text including them' });
  assert.ok(fixtureBody.includes('比多数办公本轻一截') && fixtureBody.includes(sensory));
  results.push({ id: 'length-fixture-boundary', record: historical[1], conclusion: 'Length passed 3/3, but verifier was a fixture; unsupported comparison/sensation appears in R3. Not evidence of 3/3 factual success or live verifier miss.' });
  await save('results.json', { offlineAssertionsPassed: true, liveCalls: 0, networkCalls: 0, observations: results });
} catch (error) {
  await save('failure.json', { message: error.message, stack: error.stack, completedObservations: results });
  throw error;
} finally {
  globalThis.fetch = actualFetch;
  const after = {};
  for (const name of Object.keys(before)) after[name] = sha(await read(name));
  await save('integrity.json', { before, after, changedDuringProbe: Object.keys(before).filter(name => before[name] !== after[name]), note: 'Concurrent windows may change shared files; this probe writes only its own script and output subtree.' });
}
console.log(JSON.stringify({ output: run, offlineAssertionsPassed: true, liveCalls: 0, observations: results.length }));
