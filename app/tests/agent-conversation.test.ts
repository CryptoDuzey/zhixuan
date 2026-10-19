import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createDraft, editDraft, handleMessage, newSession, reviseDraft, writeFromNeed, type AgentEvent, type NeedCard } from '../lib/agent.ts';
import { createRun, withRun } from '../lib/agent-runtime.ts';
import { createConversationSources } from '../lib/agent-conversation.ts';
import type { CatalogEntry } from '../lib/catalog.ts';
import type { ImageRef } from '../lib/facts.ts';

const root = 'P1-产品参数库/';
const documents = [
  { id: 'new-win', path: `${root}02-MateBook-Windows/MateBook 新款/产品事实.md`, text: '# HUAWEI MateBook 新款\n## 操作系统\nWindows 11\n## 屏幕\n仅新款 Windows 屏幕事实' },
  { id: 'new-limit', path: `${root}02-MateBook-Windows/MateBook 新款/卖点与限制.md`, text: '# 限制\n需核实应用版本' },
  { id: 'new-harmony', path: `${root}01-鸿蒙电脑/MateBook 新款/产品事实.md`, text: '# HUAWEI MateBook 新款\n## 操作系统\nHarmonyOS\n## 屏幕\n仅新款鸿蒙屏幕事实' },
  { id: 'harmony-limit', path: `${root}01-鸿蒙电脑/MateBook 新款/卖点与限制.md`, text: '# 限制\n鸿蒙应用需单独确认' },
  { id: 'discovery', path: `${root}07-扩展产品目录/显示器/01-MateView 新款.md`, text: '# HUAWEI MateView 新款\n- 产品类别：显示器\n## 状态\n仅产品发现，缺少完整规格' },
];
const need = { intent: 'create', platform: '朋友圈', scene: '开学', audience: '学生', facts_from_user: [], unknowns: [], unsupported_requests: [], next_action: 'write' };
const route = (extra: Record<string, unknown> = {}) => ({ ...need, modelId: 'catalog:new-win', evidenceModelIds: ['catalog:new-win'], reply: '', ...extra });
const article = (factId = 'catalog:new-win:E1') => ({
  title: '开学选电脑', lead: '', body: 'HUAWEI MateBook 新款，Windows 11。', cta: '请以华为官方规格页及实际销售 SKU 为准。',
  tags: [], images: [{ imageId: 'MADE_UP', position: '正文后', caption: '虚构图片' }],
  claims: [{ id: 'C1', text: 'Windows 11', factIds: [factId] }],
});
const checked = { issues: [], verified_claim_ids: ['C1'] };

function transport(t: TestContext, answers: unknown[]) {
  t.mock.method(process, 'cwd', () => fileURLToPath(new URL('.', import.meta.url)));
  const saved = process.env.OPENAI_NEXT_API_KEY;
  process.env.OPENAI_NEXT_API_KEY = 'offline-placeholder';
  t.after(() => { if (saved === undefined) delete process.env.OPENAI_NEXT_API_KEY; else process.env.OPENAI_NEXT_API_KEY = saved; });
  const calls: { messages: { content: string }[] }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/chat/completions')) {
      const request = JSON.parse(String(init?.body));
      calls.push(request);
      assert.ok(answers.length, '不应增加额外模型调用');
      return Response.json({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }] });
    }
    if (url.pathname === '/documents') return Response.json({ items: documents.map((doc) => ({ ...doc, title: doc.path.split('/').at(-1), bytes: 100, sha256: '' })) });
    if (url.pathname === '/document') {
      const doc = documents.find((item) => item.id === url.searchParams.get('id'));
      assert.ok(doc, '不得读取其他产品或虚构资料');
      return new Response(doc.text);
    }
    assert.fail(`意外网络请求：${url.pathname}`);
  });
  return calls;
}

test('默认入口：问候交由模型回复，无五款选择；对话历史进入理解', async (t) => {
  const calls = transport(t, [route({ intent: 'chat', modelId: null, evidenceModelIds: [], reply: '你好，今天想聊什么？' })]);
  const events: AgentEvent[] = [];
  const s = newSession();
  await handleMessage('你好', s, (event) => events.push(event), '用户：我在筹备开学内容');
  assert.equal(calls.length, 1);
  assert.ok(events.some((event) => event.type === 'notice' && event.text === '你好，今天想聊什么？'));
  assert.ok(!events.some((event) => event.type === 'clarify'));
  assert.match(JSON.stringify(calls[0]), /筹备开学内容/);
  assert.match(JSON.stringify(calls[0]), /MateView/);
  assert.equal(s.modelId, '');
});

test('默认入口：未选型号可自主用目录完整产品写稿，缺图仍交文字且核验引用', async (t) => {
  const calls = transport(t, [route(), article(), checked]);
  const s = newSession();
  const events: AgentEvent[] = [];
  await withRun('offline-marketing', createRun(), () => {}, () => handleMessage('给学生写一篇朋友圈，你来选合适产品', s, (event) => events.push(event)), { maxModelAttempts: 3 });
  assert.equal(s.draft?.modelId, 'catalog:new-win');
  assert.deepEqual(s.draft?.images, []);
  assert.ok(s.evidence?.every((item) => item.id.startsWith('catalog:new-win:')));
  assert.ok(events.some((event) => event.type === 'notice' && /补图/.test(event.text)));
  assert.ok(events.some((event) => event.type === 'check'));
  assert.ok(!events.some((event) => event.type === 'clarify'));
  assert.match(calls[1].messages[1].content, /仅新款 Windows/);
  assert.doesNotMatch(calls[1].messages[1].content, /仅新款鸿蒙/);
  assert.equal(calls.length, 3);
});

test('默认入口：普通选购问题读取所选目录证据后由模型回答', async (t) => {
  const calls = transport(t, [
    route({ intent: 'chat' }),
    { reply: '这款资料写的是 Windows 11；具体应用版本需要核实。' },
  ]);
  const events: AgentEvent[] = [];
  await handleMessage('这款新电脑适合我吗？', newSession(), (event) => events.push(event));
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[1].content, /Windows 11/);
  assert.match(calls[1].messages[1].content, /需核实应用版本/);
  assert.ok(events.some((event) => event.type === 'notice' && /Windows 11/.test(event.text)));
});

test('默认入口：发现级产品也能给有边界的文字草稿，不借用完整产品参数', async (t) => {
  const calls = transport(t, [
    route({ modelId: 'catalog:discovery', evidenceModelIds: ['catalog:discovery'] }),
    { ...article('catalog:discovery:E1'), body: 'HUAWEI MateView 新款，先按桌面使用场景整理需求；尺寸及接口待确认。' }, checked,
  ]);
  const s = newSession();
  await createDraft('为MateView新款写朋友圈，缺资料的地方标出来', s, () => {});
  assert.equal(s.draft?.modelId, 'catalog:discovery');
  assert.deepEqual(s.draft?.images, []);
  assert.match(calls[1].messages[1].content, /仅供产品发现/);
  assert.doesNotMatch(calls[1].messages[1].content, /Windows 11|仅新款鸿蒙/);
  assert.ok(s.need?.unknowns.some((value) => /规格|资料/.test(value)));
});

test('默认入口：旧五款阻断状态不再拦截聊天', async (t) => {
  transport(t, [route({ intent: 'chat', modelId: null, evidenceModelIds: [], reply: '可以，先聊你的内容方向。' })]);
  const s = { ...newSession(), modelGuard: { kind: 'choose' as const } };
  const events: AgentEvent[] = [];
  await handleMessage('先不选型号，聊聊内容方向', s, (event) => events.push(event));
  assert.equal(s.modelGuard, undefined);
  assert.ok(events.some((event) => event.type === 'notice' && /内容方向/.test(event.text)));
});

test('已有草稿后仍可自由聊天，模型回答不会改动草稿及核验版本', async (t) => {
  const calls = transport(t, [
    route(), article(), checked,
    route({ intent: 'chat', modelId: null, evidenceModelIds: [], reply: '可以，标题先说清读者遇到的问题。' }),
  ]);
  const s = newSession();
  await handleMessage('写一篇开学朋友圈', s, () => {});
  const previous = JSON.stringify({ draft: s.draft, report: s.report, evidence: s.evidence });
  const events: AgentEvent[] = [];
  await handleMessage('先聊聊好标题应该怎么写', s, (event) => events.push(event));
  assert.equal(calls.length, 4);
  assert.ok(events.some((event) => event.type === 'notice' && /读者遇到的问题/.test(event.text)));
  assert.ok(!events.some((event) => event.type === 'draft' || event.type === 'clarify'));
  assert.equal(JSON.stringify({ draft: s.draft, report: s.report, evidence: s.evidence }), previous);
});

test('本型号图片读取失败时仍交付有证据的文字草稿，并提示补图', async (t) => {
  transport(t, [article(), checked]);
  const entry: CatalogEntry = {
    id: 'catalog:new-win', name: 'HUAWEI MateBook 新款', category: '电脑', system: 'Windows 11',
    level: 'full', creativeModelId: 'd14', docPath: '产品事实', evidencePaths: ['产品事实'], specsAvailable: true, note: '',
  };
  const sources = createConversationSources([entry], {
    loadCatalogEvidence: async () => [{
      id: 'catalog:new-win:E1', kind: 'fact', line: 1, source: '本地已下载知识库', readAt: new Date().toISOString(),
      docId: 'new-win', docPath: entry.docPath, docTitle: '产品事实', section: '操作系统', text: 'Windows 11',
    }],
    loadImages: async () => { throw new Error('image service unavailable'); },
  });
  const s = { ...newSession(), modelId: entry.id, modelName: entry.name };
  const events: AgentEvent[] = [];
  await writeFromNeed(need as NeedCard, '写朋友圈', s, (event) => events.push(event), sources);
  assert.ok(s.draft?.body);
  assert.deepEqual(s.draft?.images, []);
  assert.ok(events.some((event) => event.type === 'notice' && /无法读取.*补图/.test(event.text)));
  assert.equal(s.report?.draftVersion, s.draft?.version);
  assert.ok(!s.report?.issues.some((issue) => issue.type === 'fabricated'));
});

test('默认入口：换系统后清除旧稿和需求，只用新版本资料；改稿/编辑仍核验', async (t) => {
  const calls = transport(t, [
    route(), article(), checked,
    route({ modelId: 'catalog:new-harmony', evidenceModelIds: ['catalog:new-harmony'], facts_from_user: ['改成鸿蒙版本'] }),
    { ...article('catalog:new-harmony:E1'), body: 'HUAWEI MateBook 新款，HarmonyOS。' }, checked,
    route({ intent: 'revise', modelId: 'catalog:new-harmony', evidenceModelIds: ['catalog:new-harmony'] }),
    { ...article('catalog:new-harmony:E1'), body: 'HUAWEI MateBook 新款，HarmonyOS。短一点。' }, checked,
    checked,
  ]);
  const s = newSession();
  await handleMessage('为Windows新款写朋友圈', s, () => {});
  await handleMessage('改成鸿蒙版本', s, () => {});
  assert.equal(s.draft?.modelId, 'catalog:new-harmony');
  assert.equal(s.draft?.version, 1);
  assert.doesNotMatch(calls[4].messages[1].content, /Windows 11|仅新款 Windows/);
  await reviseDraft('短一点', s, () => {});
  assert.equal(s.draft?.version, 2);
  await editDraft({ title: '新的标题' }, s, () => {});
  assert.equal(s.draft?.version, 3);
  assert.equal(s.report?.draftVersion, 3);
  assert.ok(s.report?.issues.some((issue) => issue.type === 'image'));
});

test('目录素材映射：只转换明确映射的本型号图片，其他产品不借图，证据编号不改写', async () => {
  const entry: CatalogEntry = {
    id: 'catalog:mapped', name: '目录产品', category: '电脑', system: 'Windows',
    level: 'full', creativeModelId: 'd14', docPath: '产品事实', evidencePaths: ['产品事实'], specsAvailable: true, note: '',
  };
  const loads: string[] = [];
  const sources = createConversationSources([entry, { ...entry, id: 'catalog:unmapped', creativeModelId: undefined }], {
    loadCatalogEvidence: async (id) => { loads.push(`evidence:${id}`); return []; },
    loadImages: async (id) => {
      loads.push(`images:${id}`);
      return [{ id: 'IMG1', modelId: 'd14' }, { id: 'IMG2', modelId: 'pro-s' }] as ImageRef[];
    },
  });
  assert.deepEqual(await sources.loadImages('catalog:unmapped'), []);
  const images = await sources.loadImages(entry.id);
  assert.deepEqual(images.map(({ id, modelId }) => ({ id, modelId })), [{ id: 'IMG1', modelId: entry.id }]);
  await sources.loadEvidence(entry.id);
  assert.deepEqual(loads, ['images:d14', 'evidence:catalog:mapped']);
  await assert.rejects(sources.loadEvidence('catalog:fake'), /目录/);
});

test('默认入口：多产品聊天分别读取证据，不生成任意单款稿件', async (t) => {
  const calls = transport(t, [
    route({ intent: 'chat', modelId: null, evidenceModelIds: ['catalog:new-win', 'catalog:new-harmony'] }),
    { reply: '这两款的系统分别是 Windows 11 和 HarmonyOS，应用版本都需要分别核实。' },
  ]);
  const s = newSession();
  await handleMessage('对比新款的两个系统版本', s, () => {});
  assert.equal(s.draft, undefined);
  assert.match(calls[1].messages[1].content, /仅新款 Windows/);
  assert.match(calls[1].messages[1].content, /仅新款鸿蒙/);
  assert.match(calls[1].messages[1].content, /catalog:new-win:E/);
  assert.match(calls[1].messages[1].content, /catalog:new-harmony:E/);
});

test('默认入口：资料不足的无产品场景草稿仍可写，伪造证据不能通过核验', async (t) => {
  transport(t, [
    route({ modelId: 'catalog:fake', evidenceModelIds: ['catalog:fake'] }), article('E999'), checked,
  ]);
  const s = newSession();
  await handleMessage('先给没有型号参数的场景文字草稿', s, () => {});
  assert.ok(s.draft?.body);
  assert.deepEqual(s.evidence, []);
  assert.deepEqual(s.draft?.images, []);
  assert.ok(s.report?.issues.some((issue) => issue.type === 'fabricated' && issue.severity === 'block'));
});

test('默认入口：版本需要追问时撤销旧稿，短答保留任务，并仅加载新版本证据', async (t) => {
  const calls = transport(t, [
    route(), article(), checked,
    route({ modelId: null, next_action: 'clarify', question: '要鸿蒙版本还是 Windows 版本？' }),
    route({ modelId: 'catalog:new-harmony' }), { ...article('catalog:new-harmony:E1'), body: 'HarmonyOS。' }, checked,
  ]);
  const s = newSession();
  await handleMessage('为Windows新款写朋友圈', s, () => {});
  await handleMessage('重新为新款写开学文案，还没有确定系统', s, () => {});
  assert.equal(s.draft, undefined);
  assert.equal(s.report, undefined);
  assert.equal(s.evidence, undefined);
  await handleMessage('鸿蒙', s, () => {});
  assert.equal(s.draft?.modelId, 'catalog:new-harmony');
  assert.match(calls[4].messages[1].content, /重新为新款写开学文案/);
  assert.doesNotMatch(calls[5].messages[1].content, /Windows 11|仅新款 Windows/);
});
