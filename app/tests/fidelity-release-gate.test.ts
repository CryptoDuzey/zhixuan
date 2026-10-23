import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { CheckReport, Draft, Issue } from '../lib/check.ts';
import * as check from '../lib/check.ts';
import { draftMessage } from '../lib/draft-message.ts';

const draft: Draft = { version: 1, platform: '朋友圈', modelId: 'pro-s', modelName: 'MateBook Pro S', title: '', lead: '', body: '拿整套装备比较重量，再决定是否适合自己的通勤路线。', cta: '', tags: [], images: [], claims: [{ id: 'C1', text: '普通行动建议', factIds: ['E1'] }] };
const report = (issues: Issue[] = []): CheckReport => ({ draftVersion: 1, status: 'pass', issues, verifiedClaimIds: [], reviewedClaimIds: ['C1'], verifiedImageIds: [], checkedAt: '' });
const issue = (type: Issue['type'], severity: Issue['severity'] = 'warn'): Issue => ({ type, severity, location: '正文', text: '固定问题原句', reason: '原审查已经登记的问题', action: '改写' });
const api = () => {
  assert.equal(typeof check.hasBlockingIssues, 'function', 'Shared guard must exist');
  assert.equal(typeof check.isPublishableReport, 'function', 'Shared release check must exist');
  return check;
};

test('冻结四类事实提醒必须拦，其他提醒不全量升级；已有block仍拦', () => {
  const { hasBlockingIssues, isPublishableReport } = api();
  for (const type of ['evidence', 'conflict', 'fabricated', 'absolute'] as const) {
    const r = report([issue(type)]);
    assert.equal(hasBlockingIssues(r), true, type);
    assert.equal(isPublishableReport(r, draft), false, type);
    assert.ok(!draftMessage(draft, r).includes('写好了'), type);
  }
  for (const type of ['format', 'image', 'model', 'price', 'promise'] as const) {
    assert.equal(hasBlockingIssues(report([issue(type)])), false, type);
    assert.equal(isPublishableReport(report([issue(type)]), draft), true, type);
    assert.equal(hasBlockingIssues(report([issue(type, 'block')])), true, type);
  }
});

test('合并归一事实严重度但不修改原输入；自然行动建议和format提醒仍通过', () => {
  const facts = ['evidence', 'conflict', 'fabricated', 'absolute'].map(type => issue(type as Issue['type']));
  const det = report([issue('format')]);
  const ev = { ...report(facts), draftVersion: 1 };
  const original = JSON.stringify({ det, ev });
  const merged = check.mergeReports(det, ev);
  assert.equal(merged.status, 'needs_fix');
  assert.ok(merged.issues.filter(row => row.type !== 'format').every(row => row.severity === 'block'));
  assert.equal(merged.issues[0].severity, 'warn');
  assert.equal(JSON.stringify({ det, ev }), original);
  const advice = check.mergeReports(det, report());
  assert.equal(advice.status, 'pass');
  assert.equal(api().isPublishableReport(advice, draft), true);
});

test('没有报告、过期、未完成处置或非pass不能宣称交付就绪', () => {
  const { isPublishableReport } = api();
  for (const r of [undefined, { ...report(), draftVersion: 2 }, { ...report(), reviewedClaimIds: undefined }, { ...report(), status: 'needs_fix' as const }]) {
    assert.equal(isPublishableReport(r, draft), false);
    assert.ok(!draftMessage(draft, r).includes('写好了'));
  }
  assert.equal(isPublishableReport(report(), draft), true);
});

test('原式旧报告不改写也拒绝导出；事实warn变体409、format和普通建议200；仅format不能冒充检出', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'zhixuan-fidelity-gate-'));
  // Portable unit fixture; the separate experiment preserves and replays the
  // FULL real R1/new-miss sessions. No ignored private artifacts needed in CI.
  const old = { schema: 1, session: { modelId: draft.modelId, modelName: draft.modelName, draft,
    report: report([{ ...issue('absolute'), text: '放进通勤包比多数轻薄本少一截负担' }]), evidence: [], images: [] },
    messages: [], calls: [], busy: false, interrupted: false, updatedAt: '2026-10-22T09:00:00.000Z' };
  const raw = JSON.stringify(old);
  const id = 'fidelity-old-record';
  writeFileSync(join(directory, `${id}.json`), raw);
  const previous = process.env.ZHIXUAN_SESSION_DIR;
  process.env.ZHIXUAN_SESSION_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.ZHIXUAN_SESSION_DIR; else process.env.ZHIXUAN_SESSION_DIR = previous;
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  const { GET } = await import('../app/api/export/route.ts');
  const { sessionRepository } = await import('../lib/store.ts');
  const request = (name: string) => new Request(`http://localhost/api/export?sessionId=${name}`);
  const response = await GET(request(id));
  assert.equal(response.status, 409);
  const blocked = await response.json();
  assert.ok(blocked.issues.some((row: Issue) => row.text === '放进通勤包比多数轻薄本少一截负担'));
  assert.equal(readFileSync(join(directory, `${id}.json`), 'utf8'), raw);
  const fresh = { ...old, session: { ...old.session, draft: { ...draft, body: '通勤路上少压一点' }, report: report([issue('format')]) } };
  for (const [index, r] of [report([issue('evidence')]), report([issue('conflict')]), report([issue('fabricated')]), report([issue('absolute')]), report([issue('format')]), report()].entries()) {
    const key = `fidelity-matrix-${index}`;
    const record = sessionRepository.get(key);
    record.session = { ...old.session, draft, report: r, supplementaryImages: [] };
    sessionRepository.save(key);
    assert.equal((await GET(request(key))).status, index < 4 ? 409 : 200);
  }
  const freshId = 'fidelity-new-miss';
  writeFileSync(join(directory, `${freshId}.json`), JSON.stringify(fresh));
  assert.equal((await GET(request(freshId))).status, 200, 'This is an unresolved detector miss, not a gate gain');
});
