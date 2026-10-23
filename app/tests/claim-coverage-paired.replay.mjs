// Paired replay, not a fresh model score. Uses identical recorded primary replies.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { verifyEvidence } from '../lib/agent.ts';
const folder = '../output/iterations/verifier-coverage-guard-v2-20261021';
const recorded = JSON.parse(readFileSync(`${folder}/candidate.json`, 'utf8'));
const input = JSON.parse(readFileSync('data/private/sessions/final-wechat-travel-1792506250983.json', 'utf8')).session;
const temporary = path.resolve('tmp', `paired-baseline-${randomUUID()}.ts`);
mkdirSync(path.dirname(temporary), { recursive: true });
writeFileSync(temporary, readFileSync('../output/iterations/verifier-coverage-20261021/agent.before.ts', 'utf8').replace(/from '\.\//g, "from '../lib/"));
const old = await import(pathToFileURL(temporary).href);
const realFetch = globalThis.fetch, results = [];
let calls = 0, raw = '';
globalThis.fetch = async (url) => {
  assert.ok(String(url).endsWith('/chat/completions'), 'No knowledge or external calls in paired replay');
  calls++;
  assert.ok(calls <= 1, 'Complete recorded primary reply must not need another model call');
  return Response.json({ choices: [{ message: { content: raw } }] });
};
try {
  for (const result of recorded.results) {
    assert.ok(!result.error && result.rawOutputs?.length === 1, 'Replay corpus must have one complete primary reply');
    const label = recorded.labels.find(item => item.id === result.id);
    const draft = label ? { ...input.draft, title: '', lead: '', body: label.text, cta: '', tags: [], images: [], claims: [] } : input.draft;
    const images = label ? [] : input.images;
    raw = result.rawOutputs[0]; calls = 0;
    const before = await old.verifyEvidence(draft, input.evidence, images);
    calls = 0;
    const after = await verifyEvidence(draft, input.evidence, images);
    assert.deepEqual(after.issues, before.issues);
    assert.deepEqual(after.verifiedClaimIds, before.verifiedClaimIds);
    results.push({ id: result.id, repeat: result.repeat, identicalIssues: true, identicalVerified: true, primaryCalls: calls });
  }
  const failure = JSON.parse(readFileSync('../output/iterations/verifier-decisions-20261021/candidate.json', 'utf8')).results.find(item => item.id === 'real-wechat' && item.repeat === 1);
  raw = JSON.stringify({ issues: failure.issues, verified_claim_ids: failure.verified }); calls = 0;
  const oldFailure = await old.verifyEvidence(input.draft, input.evidence, input.images);
  assert.equal(oldFailure.issues.length, 0);
  assert.equal(oldFailure.status, 'pass');
  assert.equal(oldFailure.verifiedClaimIds.includes('C2'), false);
  const live = JSON.parse(readFileSync(`${folder}/acceptance.json`, 'utf8'));
  const repairs = live.results.filter(item => item.scenario === 'recorded-omission-replay-plus-live-repair');
  assert.equal(repairs.length, 3);
  assert.ok(repairs.every(item => item.correct && item.report.status === 'needs_fix'));
  const summary = { method: 'same primary response through original/current real verifier functions; no resampled model',
    matchedCases: results.length, additionalIssues: 0, additionalCallsForCompleteReplies: 0,
    originalOmissionSilentlyPassed: true, liveRepairDetected: `${repairs.filter(item => item.correct).length}/3`,
    underlyingJudgeFalsePositivesSolved: false, results };
  writeFileSync(`${folder}/paired-replay.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ matchedCases: results.length, additionalIssues: 0, originalOmissionSilentlyPassed: true, liveRepairDetected: '3/3' }));
} finally { globalThis.fetch = realFetch; unlinkSync(temporary); }
