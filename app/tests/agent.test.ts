import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkClaimRefs, createDraft, dedupeByContainment, editDraft, handleMessage, newSession, reviseDraft, selectEvidence, understandPrompt, verifyEvidence, writeFromNeed, type AgentEvent, type AgentSources, type NeedCard, type Session } from '../lib/agent.ts';
import { ambiguousModel, type Evidence, type ImageRef, type ModelEntry } from '../lib/facts.ts';
import type { Draft } from '../lib/check.ts';

const ev = (id: string, kind: Evidence['kind'], docTitle: string): Evidence => ({
  id, docId: 'd', docTitle, docPath: 'p', line: 1, section: '', text: id, kind, source: '本地已下载知识库', readAt: '',
});
const ALL = [
  ev('E001', 'fact', '产品事实'),
  ev('E002', 'limit', '卖点与限制'),
  ev('E003', 'price', '价格卡'),
  ev('E004', 'scene', '学生用户沟通卡'),
  ev('E005', 'scene', '商务差旅沟通卡'),
  ev('E006', 'rule', '售后与促销表述红线'),
];
const ids = (l: Evidence[]) => l.map((e) => e.id);

test('学生场景：事实+限制+学生卡，不含价格与差旅卡', () => {
  assert.deepEqual(ids(selectEvidence(ALL, { audience: '大学新生', wantPrice: false })), ['E001', 'E002', 'E004']);
});

test('差旅场景：带入差旅卡；被问价格才带价格卡', () => {
  assert.deepEqual(ids(selectEvidence(ALL, { scene: '出差办公', wantPrice: true })), ['E001', 'E002', 'E003', 'E005']);
});

test('场景不明：不替用户猜，两张场景卡都带入', () => {
  assert.deepEqual(ids(selectEvidence(ALL, { wantPrice: false })), ['E001', 'E002', 'E004', 'E005']);
});

test('规则文档不进入写作证据', () => {
  assert.ok(!ids(selectEvidence(ALL, { audience: '学生', wantPrice: true })).includes('E006'));
});

const draft = (claims: Draft['claims']): Draft => ({
  version: 1, platform: '小红书', modelId: 'pro-s', modelName: 'HUAWEI MateBook Pro S',
  title: '', lead: '', body: '', cta: '', tags: [], images: [], claims,
});

test('claim 引用不存在的证据编号 → 拦截', () => {
  const issues = checkClaimRefs(draft([{ id: 'C1', text: '续航长达 20 小时', factIds: ['E999'] }]), ALL);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'fabricated');
  assert.equal(issues[0].severity, 'block');
});

test('claim 没有绑定依据 → 拦截；正常绑定 → 通过', () => {
  assert.equal(checkClaimRefs(draft([{ id: 'C1', text: '某主张', factIds: [] }]), ALL)[0].type, 'evidence');
  assert.equal(checkClaimRefs(draft([{ id: 'C1', text: '某主张', factIds: ['E001', 'E002'] }]), ALL).length, 0);
});

test('不支持的要求按包含关系去重', () => {
  assert.deepEqual(dedupeByContainment(['到手价', '叠加补贴到手价', '最后一天', '最后一天']).sort(), ['叠加补贴到手价', '最后一天']);
});

test('MateBook 14 未指明版本 → 需要澄清；写明后不再追问', () => {
  assert.equal(ambiguousModel('给我写一篇 MateBook 14 的小红书')?.length, 2);
  assert.equal(ambiguousModel('MateBook 14 酷睿 Ultra 的文案'), null);
  assert.equal(ambiguousModel('MateBook Pro S 的文案'), null);
});

const readyNeed = (): NeedCard => ({
  intent: 'create', platform: '朋友圈', scene: '开学', audience: '大学新生',
  facts_from_user: [], unknowns: [], unsupported_requests: [], next_action: 'write',
});

const TEST_MODELS: ModelEntry[] = [
  { id: 'pro-s', name: 'HUAWEI MateBook Pro S', system: 'HarmonyOS', ready: true },
  { id: 'mb14-harmony', name: 'HUAWEI MateBook 14（鸿蒙电脑）', system: 'HarmonyOS', ready: true },
  { id: 'mb14-ultra', name: 'MateBook 14 酷睿 Ultra（Windows）', system: 'Windows', ready: true },
  { id: 'd14', name: 'HUAWEI MateBook D 14', system: 'Windows', ready: true },
  { id: 'd16', name: 'HUAWEI MateBook D 16', system: 'Windows', ready: true },
];

function completedSession(modelId = 'pro-s'): Session {
  const model = TEST_MODELS.find((m) => m.id === modelId)!;
  return {
    ...newSession(), modelId, modelName: model.name, need: readyNeed(),
    draft: { ...draft([]), platform: '朋友圈', modelId, modelName: model.name }, evidence: ALL, images: [],
    report: { draftVersion: 1, status: 'pass', issues: [], verifiedClaimIds: [], verifiedImageIds: [], checkedAt: '' },
  };
}

function mockSources(t: TestContext): AgentSources {
  return {
    models: TEST_MODELS.map((m) => ({ ...m })),
    loadEvidence: t.mock.fn(async (id: string) => [{
      ...ev('E001', 'fact', `${id} 产品事实`), text: `${id} 专属证据`,
    }]),
    loadImages: t.mock.fn(async (id: string) => [{
      ...image('IMG1', true), modelId: id, modelName: TEST_MODELS.find((m) => m.id === id)!.name,
    }]),
  };
}

// 所有网络均被替身截断；即使守卫失效，也不会连接模型或知识库。
function offlineTransport(t: TestContext, mode: 'clarify' | 'write' = 'clarify', plannedImages: Draft['images'] = [{ imageId: 'IMG1', position: '正文后', caption: '产品配图' }]) {
  // 设置模块会按 cwd 读私有设置；将其定位到测试目录，避免读取用户保存的密钥。
  t.mock.method(process, 'cwd', () => fileURLToPath(new URL('.', import.meta.url)));
  const savedKey = process.env.OPENAI_NEXT_API_KEY;
  process.env.OPENAI_NEXT_API_KEY = 'offline-test-placeholder';
  t.after(() => {
    if (savedKey === undefined) delete process.env.OPENAI_NEXT_API_KEY;
    else process.env.OPENAI_NEXT_API_KEY = savedKey;
  });
  return t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    const system = request.messages[0].content;
    const data = system.includes('需求理解模块')
      ? mode === 'write' ? readyNeed() : { ...readyNeed(), platform: null, next_action: 'clarify', question: '想发在哪个平台？' }
      : system.includes('严格的事实核验模块')
        ? { issues: [], verified_claim_ids: ['C1'] }
        : {
          title: '本轮产品文案', lead: '', body: '本轮有依据的产品介绍。', cta: '请以官网规格页为准', tags: [],
          claims: [{ id: 'C1', text: '本轮有依据的产品介绍。', factIds: ['E001'] }],
          images: plannedImages,
        };
    return Response.json({ choices: [{ message: { content: JSON.stringify(data) } }] });
  });
}

test('新会话不预选产品；你好先问用途和产品并提供五型号，无API调用', async (t) => {
  const transport = offlineTransport(t);
  const sources = mockSources(t);
  const s = newSession();
  assert.equal(s.modelId, '');
  assert.equal(s.modelName, '');
  const events: AgentEvent[] = [];
  await handleMessage('你好', s, (e) => events.push(e), '', sources);
  const question = events.find((e) => e.type === 'clarify');
  assert.ok(question?.type === 'clarify');
  assert.match(question.question, /用途|场景/);
  assert.equal(question.options?.length, 5);
  assert.equal(transport.mock.callCount(), 0);
  assert.equal(s.modelId, '');
});

const SUPPORTED_NAMES = [
  ['MateBook Pro S', 'pro-s'], ['MateBook14 鸿蒙', 'mb14-harmony'],
  ['MateBook 14 Windows', 'mb14-ultra'], ['MateBook14 酷睿 Ultra', 'mb14-ultra'],
  ['MateBook D 14', 'd14'], ['D14', 'd14'], ['D16', 'd16'], ['MateBook D16', 'd16'],
  ['本轮产品选择：HUAWEI MateBook 14 鸿蒙版', 'mb14-harmony'],
  ['本轮产品选择：MateBook 14 酷睿 Ultra Windows 版', 'mb14-ultra'],
];
for (const [name, id] of SUPPORTED_NAMES) {
  test(`${name}使用自己的事实、图片和稿件型号，不混入Pro S`, async (t) => {
    const transport = offlineTransport(t, 'write');
    const sources = mockSources(t);
    const s = newSession();
    const loaded: string[] = [];
    const read = sources.loadEvidence;
    sources.loadEvidence = async (modelId, opts) => { loaded.push(`facts:${modelId}`); return read(modelId, opts); };
    const images = sources.loadImages;
    sources.loadImages = async (modelId) => { loaded.push(`images:${modelId}`); return images(modelId); };
    await handleMessage(`${name}给学生开学写朋友圈`, s, () => {}, '', sources);
    assert.equal(s.modelId, id);
    assert.equal(s.draft?.modelId, id);
    assert.equal(s.draft?.modelName, sources.models.find((m) => m.id === id)?.name);
    assert.deepEqual(loaded, [`facts:${id}`, `images:${id}`]);
    assert.ok(s.images?.every((i) => i.modelId === id));
    assert.equal(transport.mock.callCount(), 3);
    const prompt = JSON.parse(String(transport.mock.calls[1].arguments[1]?.body)).messages[1].content;
    assert.ok(prompt.includes(`${id} 专属证据`));
    assert.ok(prompt.includes(`产品：${s.modelName}`));
  });
}

for (const model of ['MateBook D16 SE', 'D16 Pro', 'MateBook 14 Plus', 'MateBook 14s', 'MateBook X Pro', 'MateBook GT', 'D15']) {
  test(`未接入型号 ${model} 在调用模型前停止，且不返回旧稿完成状态`, async (t) => {
    const transport = offlineTransport(t);
    const s = completedSession();
    const events: AgentEvent[] = [];
    await handleMessage(`改写${model}的朋友圈`, s, (e) => events.push(e), '', mockSources(t));
    assert.equal(transport.mock.callCount(), 0);
    assert.equal(s.draft, undefined);
    assert.equal(s.report, undefined);
    assert.equal(s.evidence, undefined);
    assert.equal(s.images, undefined);
    assert.match(JSON.stringify(events), /尚未接入/);
    assert.ok(!events.some((e) => e.type === 'draft' || e.type === 'check' || e.type === 'step'));
  });
}

for (const [answer, id] of [['Windows', 'mb14-ultra'], ['鸿蒙', 'mb14-harmony'], ['不是Windows，是鸿蒙', 'mb14-harmony']]) {
  test(`MateBook14 追问后短答${answer}保留14及本次任务上下文`, async (t) => {
    const transport = offlineTransport(t, 'write');
    const sources = mockSources(t);
    const s = completedSession();
    const events: AgentEvent[] = [];
    const emit = (e: AgentEvent) => events.push(e);
    await handleMessage('给学生开学写一篇MateBook14的朋友圈', s, emit, '旧产品的历史参数', sources);
    assert.equal(s.draft, undefined);
    assert.ok(events.some((e) => e.type === 'clarify' && /Windows/.test(e.question) && /鸿蒙/.test(e.question)));
    events.length = 0;
    assert.equal(transport.mock.callCount(), 0);
    await handleMessage(answer, s, emit, '旧产品的历史参数', sources);
    assert.equal(s.draft?.modelId, id);
    const prompt = JSON.parse(String(transport.mock.calls[0].arguments[1]?.body)).messages[1].content;
    assert.match(prompt, /给学生开学写一篇MateBook14的朋友圈/);
    assert.doesNotMatch(prompt, /旧产品的历史参数/);
  });
}

test('阻断后须明确选已接入型号；否定、普通继续不能解除，D14可恢复', async (t) => {
  const transport = offlineTransport(t);
  const s = newSession();
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent) => events.push(e);
  const sources = mockSources(t);
  await handleMessage('MateBook GT写朋友圈', s, emit, '', sources);
  await handleMessage('不要Pro S', s, emit, '', sources);
  await handleMessage('继续写', s, emit, '', sources);
  assert.equal(transport.mock.callCount(), 0);
  await handleMessage('改用D14', s, emit, '', sources);
  assert.equal(transport.mock.callCount(), 1);
  assert.equal(s.modelId, 'd14');
  assert.equal(s.draft, undefined);
});

test('同时要求多个型号时先澄清，不任取一个型号交付', async (t) => {
  const transport = offlineTransport(t);
  const s = completedSession();
  await handleMessage('对比MateBook Pro S和D14写朋友圈', s, () => {}, '', mockSources(t));
  assert.equal(transport.mock.callCount(), 0);
  assert.equal(s.draft, undefined);
});

test('直接创作、改稿、编辑和需求写作入口也遵守阻断状态', async (t) => {
  const transport = offlineTransport(t);
  const s = completedSession();
  const sources = mockSources(t);
  await createDraft('MateBook GT', s, () => {}, '', sources);
  await writeFromNeed(readyNeed(), '继续', s, () => {}, sources);
  await reviseDraft('压缩到100字', s, () => {}, sources);
  await editDraft({ body: '修改后的正文' }, s, () => {}, sources);
  assert.equal(transport.mock.callCount(), 0);
  assert.equal(s.draft, undefined);
  assert.equal(s.report, undefined);
});

for (const text of ['不要把MateBook GT写成Pro S', 'MateBook GT不要写成Pro S']) {
  test(`纠错要求“${text}”仍必须停止，不能忽略实际请求的型号`, async (t) => {
    const transport = offlineTransport(t);
    const s = completedSession();
    await handleMessage(text, s, () => {}, '', mockSources(t));
    assert.equal(transport.mock.callCount(), 0);
    assert.equal(s.draft, undefined);
  });
}

test('询问、假设和多种否定表达不会被当成选择Pro S', async (t) => {
  const transport = offlineTransport(t);
  const s = newSession();
  const sources = mockSources(t);
  await handleMessage('MateBook GT写朋友圈', s, () => {}, '', sources);
  for (const text of ['不使用Pro S', '不要选择Pro S', '不是要用Pro S', '我没选Pro S', '用Pro S也不要', '用Pro S吗', '如果选Pro S', '考虑选Pro S', '介绍Pro S']) {
    await handleMessage(text, s, () => {}, '', sources);
    assert.equal(transport.mock.callCount(), 0, text);
    assert.equal(s.draft, undefined);
  }
});

for (const text of ['Pro S', '就选MateBook Pro S', '不要MateBook GT，改用MateBook Pro S', 'MateBook GT不写了，改用Pro S']) {
  test(`明确选择“${text}”可解除阻断`, async (t) => {
    const transport = offlineTransport(t);
    const s = newSession();
    const sources = mockSources(t);
    await handleMessage('MateBook GT写朋友圈', s, () => {}, '', sources);
    await handleMessage(text, s, () => {}, '', sources);
    assert.equal(transport.mock.callCount(), 1);
    assert.equal(s.modelId, 'pro-s');
    assert.equal(s.modelGuard, undefined);
  });
}

test('MateBook14先选Windows再改鸿蒙，切换后只留下鸿蒙型号稿件', async (t) => {
  const transport = offlineTransport(t, 'write');
  const s = newSession();
  const sources = mockSources(t);
  await handleMessage('MateBook14', s, () => {}, '', sources);
  await handleMessage('Windows', s, () => {}, '', sources);
  await handleMessage('改成鸿蒙', s, () => {}, '', sources);
  assert.equal(s.modelId, 'mb14-harmony');
  assert.equal(s.draft?.modelId, 'mb14-harmony');
  assert.equal(transport.mock.callCount(), 6);
});

test('单独调用各写作入口、以及含其他型号的需求卡，均先拦截', async (t) => {
  const transport = offlineTransport(t);
  const sources = mockSources(t);
  const actions = [
    (s: Session) => createDraft('MateBook GT', s, () => {}, '', sources),
    (s: Session) => writeFromNeed(readyNeed(), 'MateBook GT', s, () => {}, sources),
    (s: Session) => writeFromNeed({ ...readyNeed(), facts_from_user: ['给D14写稿'] }, '继续', s, () => {}, sources),
    (s: Session) => reviseDraft('换成D14', s, () => {}, sources),
    (s: Session) => editDraft({ title: 'MateBook14 Windows 开学推荐' }, s, () => {}, sources),
  ];
  for (const action of actions) {
    const s = completedSession();
    await action(s);
    assert.equal(s.draft, undefined);
    assert.equal(s.report, undefined);
  }
  assert.equal(transport.mock.callCount(), 0);
});

test('产品切换清理旧need、旧稿和外部历史；之后的短答也不重新带入旧型号', async (t) => {
  const transport = offlineTransport(t);
  const sources = mockSources(t);
  const s = completedSession();
  s.need!.facts_from_user = ['Pro S旧参数798g'];
  s.modelHistory = ['Pro S旧参数798g'];
  await handleMessage('改用D16', s, () => {}, 'Pro S旧参数798g', sources);
  assert.equal(s.modelId, 'd16');
  assert.equal(s.draft, undefined);
  assert.equal(s.report, undefined);
  assert.ok(!s.need?.facts_from_user.includes('Pro S旧参数798g'));
  await handleMessage('朋友圈', s, () => {}, 'Pro S旧参数798g', sources);
  for (const call of transport.mock.calls) {
    assert.doesNotMatch(JSON.parse(String(call.arguments[1]?.body)).messages[1].content, /798g/);
  }
});

test('拒绝当前型号清空选择，不再沿用该型号；明确另选D16可恢复', async (t) => {
  const transport = offlineTransport(t);
  const sources = mockSources(t);
  const s = completedSession('d14');
  await handleMessage('不要D14', s, () => {}, '', sources);
  await handleMessage('继续', s, () => {}, '', sources);
  assert.equal(transport.mock.callCount(), 0);
  assert.equal(s.modelId, '');
  assert.equal(s.draft, undefined);
  await handleMessage('就用D16', s, () => {}, '', sources);
  assert.equal(s.modelId, 'd16');
  assert.equal(transport.mock.callCount(), 1);
});

test('ready:false仍阻断；单说Windows且没有14上下文时先选产品', async (t) => {
  const transport = offlineTransport(t);
  const sources = mockSources(t);
  sources.models = sources.models.map((m) => m.id === 'd14' ? { ...m, ready: false } : m);
  await handleMessage('D14写朋友圈', newSession(), () => {}, '', sources);
  const s = newSession();
  await handleMessage('Windows', s, () => {}, '', sources);
  assert.equal(s.modelId, '');
  assert.equal(transport.mock.callCount(), 0);
});

test('需求理解列出已接入产品并锁定所选型号', () => {
  const prompt = understandPrompt('写朋友圈', '', TEST_MODELS[4], TEST_MODELS);
  for (const m of TEST_MODELS) assert.ok(prompt.includes(m.name));
  assert.ok(prompt.includes('当前选定产品：HUAWEI MateBook D 16'));
  assert.doesNotMatch(prompt, /当前只接入 HUAWEI MateBook Pro S/);
});

test('产品选择器能解除未支持型号阻断，读取鸿蒙14自己的资料', async (t) => {
  const transport = offlineTransport(t, 'write');
  const sources = mockSources(t);
  const s = completedSession();
  await handleMessage('换成MateBook GT', s, () => {}, '', sources);
  await handleMessage('本轮产品选择：HUAWEI MateBook 14 鸿蒙版\n给学生写朋友圈', s, () => {}, '', sources);
  assert.equal(s.draft?.modelId, 'mb14-harmony');
  assert.equal(transport.mock.callCount(), 3);
});

test('未选产品时先说的用途，在明确选择D16后保留', async (t) => {
  const transport = offlineTransport(t, 'write');
  const sources = mockSources(t);
  const s = newSession();
  await handleMessage('给大学新生开学写朋友圈', s, () => {}, '', sources);
  assert.equal(transport.mock.callCount(), 0);
  await handleMessage('D16', s, () => {}, '', sources);
  const prompt = JSON.parse(String(transport.mock.calls[0].arguments[1]?.body)).messages[1].content;
  assert.match(prompt, /给大学新生开学写朋友圈/);
});

test('14版本被否定时撤销旧稿，不能继续写被否定的Windows版', async (t) => {
  const transport = offlineTransport(t);
  const sources = mockSources(t);
  const s = completedSession('mb14-ultra');
  await handleMessage('不要Windows', s, () => {}, '', sources);
  await handleMessage('继续写', s, () => {}, '', sources);
  assert.equal(s.modelGuard?.kind, 'mb14-version');
  assert.equal(s.draft, undefined);
  assert.equal(transport.mock.callCount(), 0);
});

test('D16小红书两图不足，去重且排除其他型号后先澄清；换朋友圈可创作', async (t) => {
  const transport = offlineTransport(t, 'write');
  const sources = mockSources(t);
  const s = completedSession('d16');
  sources.loadImages = async () => {
    const own = ['IMG1', 'IMG2'].map((id) => ({ ...image(id, true), modelId: 'd16', modelName: s.modelName }));
    return [...own, own[0], { ...own[0], id: 'IMG3' }, image('IMG4', true)];
  };
  const events: AgentEvent[] = [];
  await writeFromNeed({ ...readyNeed(), platform: '小红书' }, 'D16给学生开学写小红书', s, (e) => events.push(e), sources);
  assert.equal(transport.mock.callCount(), 0);
  assert.equal(s.images?.length, 2);
  assert.equal(s.draft, undefined);
  assert.equal(s.report, undefined);
  assert.equal(s.need?.next_action, 'clarify');
  const question = events.find((e) => e.type === 'clarify');
  assert.ok(question?.type === 'clarify');
  assert.match(question.question, /只有 2 张.*小红书至少需要 3 张/);
  assert.deepEqual(question.options, ['公众号', '朋友圈']);
  assert.ok(!events.some((e) => e.type === 'draft' || e.type === 'check' || e.type === 'step' && /撰写/.test(e.label)));
  await handleMessage('那就换朋友圈', s, () => {}, '', sources);
  assert.equal(s.draft?.modelId, 'd16');
  assert.equal(s.draft?.platform, '朋友圈');
  assert.equal(transport.mock.callCount(), 3);
  const prompt = JSON.parse(String(transport.mock.calls[0].arguments[1]?.body)).messages[1].content;
  assert.match(prompt, /D16给学生开学写小红书/);
});

test('改稿和编辑入口遇到D16小红书素材不足，也不保留完成状态或调用模型', async (t) => {
  const transport = offlineTransport(t);
  const sources = mockSources(t);
  for (const edit of [false, true]) {
    const s = completedSession('d16');
    s.draft!.platform = '小红书';
    s.need!.platform = '小红书';
    s.images = ['IMG1', 'IMG2'].map((id) => ({ ...image(id, true), modelId: 'd16' }));
    const events: AgentEvent[] = [];
    if (edit) await editDraft({ title: '开学选电脑' }, s, (e) => events.push(e), sources);
    else await reviseDraft('压缩正文', s, (e) => events.push(e), sources);
    assert.equal(s.draft, undefined);
    assert.equal(s.report, undefined);
    assert.ok(events.some((e) => e.type === 'clarify'));
  }
  assert.equal(transport.mock.callCount(), 0);
});

test('写作者仍试图重复或借用图片时移除无效选择，图片不足核验必须阻断', async (t) => {
  const plan = ['IMG1', 'IMG1', 'OTHER_MODEL', 'IMG2'].map((imageId) => ({ imageId, position: '正文后', caption: '产品配图' }));
  offlineTransport(t, 'write', plan);
  const sources = mockSources(t);
  sources.loadImages = async () => ['IMG1', 'IMG2', 'IMG3'].map((id) => ({ ...image(id, true), modelId: 'd14' }));
  const s = completedSession('d14');
  await writeFromNeed({ ...readyNeed(), platform: '小红书' }, 'D14写小红书', s, () => {}, sources);
  assert.deepEqual(s.draft?.images.map((i) => i.imageId), ['IMG1', 'IMG2']);
  assert.equal(s.report?.status, 'needs_fix');
  assert.ok(s.report?.issues.some((i) => i.type === 'image' && i.severity === 'block'));
});

const image = (id: string, visuallyReviewed?: boolean): ImageRef => ({
  id, filename: '智慧协同功能.jpg', docId: id, modelId: 'pro-s', modelName: 'HUAWEI MateBook Pro S',
  caption: visuallyReviewed ? '紫色机身打开时的侧面外观，画面没有人物' : '学生正在使用协同功能',
  purpose: '智慧协同功能', visuallyReviewed, width: 1200, height: 800, source: '本地已下载知识库', url: '',
});

test('核验按图片编号使用人工画面描述，未复核索引不再享有依据豁免', async (t) => {
  const transport = offlineTransport(t);
  const d = draft([]);
  d.images = [
    { imageId: 'IMG1', position: '开头', caption: '学生正在使用协同功能' },
    { imageId: 'IMG2', position: '结尾', caption: '学生正在使用协同功能' },
    { imageId: 'IMG3', position: '中间', caption: '智慧协同功能' },
  ];
  await verifyEvidence(d, ALL, [image('IMG1', true), image('IMG2', false), image('IMG3')]);
  assert.equal(transport.mock.callCount(), 1);
  const request = JSON.parse(String(transport.mock.calls[0].arguments[1]?.body));
  const prompt = request.messages[1].content;
  assert.match(prompt, /\[IMG1\].*已人工看图复核；实际画面描述=紫色机身.*没有人物/);
  assert.match(prompt, /\[IMG2\].*未人工看图复核；索引类别=智慧协同功能/);
  assert.match(prompt, /\[IMG3\].*未人工看图复核/);
  assert.match(prompt, /实际画面描述优先于索引类别/);
  assert.match(prompt, /未复核索引不能证明画面里的人物、动作、颜色或具体功能/);
  assert.match(prompt, /即使图注照抄类别或索引说明，也不自动视为有依据/);
  assert.match(prompt, /图注：\[IMG1\] 学生正在使用协同功能/);
  assert.doesNotMatch(prompt, /视为有依据，不要当作虚构/);
});

test('改稿的图片选择也遵守人工复核优先规则，避免先写出错误图注', async (t) => {
  const transport = offlineTransport(t);
  const s = completedSession();
  s.images = [image('IMG1', true), image('IMG2', false)];
  await reviseDraft('压缩正文', s, () => {});
  assert.equal(transport.mock.callCount(), 2); // 本地替身：改稿 + 核验
  const request = JSON.parse(String(transport.mock.calls[0].arguments[1]?.body));
  assert.match(request.messages[1].content, /实际画面描述优先于索引类别/);
  assert.match(request.messages[1].content, /未复核图片只用中性图注/);
  assert.match(request.messages[1].content, /不能证明产品功能、参数或效果/);
});
