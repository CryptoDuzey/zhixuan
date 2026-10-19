// 手动真实冒烟：从 app 目录运行 node --experimental-strip-types tests/agent-conversation.live.mjs
// 使用本机已保存模型配置，不打印配置；整个验证共享 16 次 / 5 分钟预算。
import assert from 'node:assert/strict';
import { handleMessage, newSession } from '../lib/agent.ts';
import { loadCatalog } from '../lib/catalog.ts';
import { getLlmCalls } from '../lib/llm.ts';
import { createRun, withRun } from '../lib/agent-runtime.ts';

const catalog = await loadCatalog();
assert.ok(catalog.length > 5);
const summaries = [];
const cases = [
  { name: '自由问候', text: '你好，今天先随便聊聊，不要让我先选产品。', draft: false },
  { name: '自主选品', text: '给准备开学、主要写课程报告的学生写一篇朋友圈文案，你自己从资料完整的产品里选一款，不要让我选型号；系统应用适配未核实就标待确认。', draft: true },
  { name: '五款之外完整产品', text: '为 HUAWEI MateBook D 16 SE 版 2024 写朋友圈，面向日常办公，不要换成 D16 标准版。没有图片也先给文字，未知处标明。', draft: true, product: /D 16 SE/ },
  { name: '发现卡草稿', text: '为 HUAWEI MateBook Fold 企业版写一篇朋友圈的文字草稿，只依据现有资料，没收录的规格明确留空，不要改成非凡大师，也不要用其他型号图片。', draft: true, product: /Fold 企业版/ },
];
await withRun(`marketing-smoke-${Date.now()}`, createRun(), () => {}, async () => {
  for (const item of cases) {
    const session = newSession();
    const events = [];
    await handleMessage(item.text, session, (event) => events.push(event));
    assert.ok(!events.some((event) => event.type === 'error'), `${item.name}不可返回错误`);
    if (item.draft) {
      assert.ok(session.draft?.body.trim(), `${item.name}应交付文字草稿`);
      assert.ok(session.modelId.startsWith('catalog:'));
      if (item.product) {
        assert.match(session.modelName, item.product);
        assert.deepEqual(session.draft.images, []);
      }
      assert.equal(session.report?.draftVersion, session.draft.version);
      assert.ok(session.evidence?.every((evidence) => evidence.id.startsWith(`${session.modelId}:`)));
    } else {
      assert.ok(events.some((event) => event.type === 'notice' && event.text.trim()));
      assert.ok(!events.some((event) => event.type === 'clarify'));
    }
    const summary = {
      case: item.name, model: session.modelName,
      draft: !!session.draft, characters: session.draft?.body.length,
      images: session.draft?.images.length, evidence: session.evidence?.length,
      report: session.report?.status,
      issues: session.report?.issues.map(({ type, reason }) => ({ type, reason })),
      reply: events.filter((event) => event.type === 'notice').map((event) => event.text),
    };
    summaries.push(summary);
    console.log(JSON.stringify(summary));
  }
}, { maxModelAttempts: 16, timeoutMs: 300_000 });
assert.ok(getLlmCalls().length <= 16);
console.log(JSON.stringify({ catalog: catalog.length, modelAttempts: getLlmCalls().length, cases: summaries.length, passed: true }));
