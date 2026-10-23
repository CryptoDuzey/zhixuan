import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { answerWebQuestion, isWebFollowup, type WebAnswerSources } from '../lib/web-answer.ts';
import { handleMessage, newSession, type AgentEvent } from '../lib/agent.ts';

// Offline regression: all search/page/model results below are synthetic.
// Global fetch never reaches the network. C2 supplies synthetic HTTP responses
// so a correct agent can actually search/read the replacement product offline.
const root = fileURLToPath(new URL('../../output/iterations/parallel-tools-20261022/', import.meta.url));
const run = join(root, `offline-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
mkdirSync(run, { recursive: true });
const product = 'https://consumer.huawei.com/cn/harmonyos-computer/matebook-pro-s/';
const shop = 'https://www.vmall.com/product/10086000000101.html';
const replacement = 'https://consumer.huawei.com/cn/laptops/matebook-d-14/';
const cached: WebAnswerSources = {
  status: 'ready', query: '华为 MateBook Pro S 官网介绍', searchedAt: '2026-10-21T10:00:00.000Z', provider: 'bing',
  items: [
    { id: 'WEB-PROS', title: 'MateBook Pro S 官网', url: product, snippet: 'MateBook Pro S 产品介绍' },
    { id: 'WEB-SHOP', title: 'MateBook Pro S 商城', url: shop, snippet: '选择配置查看报价' },
  ],
  // This is the shape produced by an introduction request: shop is not read.
  pages: [{ status: 'ready', url: product, readAt: '2026-10-21T10:00:00.000Z', title: 'MateBook Pro S', text: 'MateBook Pro S 产品介绍。',
    referencePrice: { amount: 7999, currency: 'CNY', display: '¥7999起', note: '价格仅供参考，具体价格请以华为商城展示为准。', sourceUrl: product,
      kind: 'page-reference', isTransactionPrice: false, hidden: true, disclaimer: '非成交价' } }],
};
const cases = [
  { id: 'C1', input: '那刚才查到的 MateBook Pro S 24GB/512GB 柔光版多少钱？请读商城报价。', criterion: '实际调用商城正文读取，不以已有介绍页缓存阻止本轮读取；不要求一定取得成交价。' },
  { id: 'C2', input: '把刚才查到的换成 MateBook D 14，告诉我官网价格。', criterion: '更换明确型号必须重新检索，不返回 Pro S 来源或 7999 元。通过真实 agent 函数入口运行。' },
  { id: 'P1', input: '联网重新查 MateBook D 14 官网价格', criterion: '显式联网可取得新产品搜索结果和来源，不能沿用旧产品来源。' },
  { id: 'P2', input: '把刚才查到的介绍压缩成一句话', criterion: '同产品仅改表达时允许复用缓存，不重复搜索或读页。' },
];
const fixed = { kind: 'SIMULATED_OFFLINE_ONLY', realHttpRequests: 0, repetitions: 2, cached, cases };
const encoded = JSON.stringify(fixed, null, 2);
writeFileSync(join(run, 'fixed-inputs-and-criteria.json'), encoded);
writeFileSync(join(run, 'input-sha256.txt'), createHash('sha256').update(encoded).digest('hex') + '\n');
console.log(`Task C evidence: ${run}`);

function save(id: string, value: unknown) { writeFileSync(join(run, `${id}.json`), JSON.stringify(value, null, 2)); }
function errorValue(error: unknown) {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
}

for (let repetition = 1; repetition <= 2; repetition++) {
  for (const c of cases) test(`${c.id}/R${repetition}: ${c.criterion}`, async t => {
    const id = `${c.id}-R${repetition}`;
    const calls: unknown[] = [];
    const transport: { kind: 'EXPECTED_MOCK_FETCH' | 'UNEXPECTED_MOCK_FETCH'; url: string }[] = [];
    const generated: unknown[] = [];
    let result: unknown;
    let unexpectedFetch = 0;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (c.id === 'C2' && url.origin === 'https://html.duckduckgo.com' && url.pathname === '/html/') {
        transport.push({ kind: 'EXPECTED_MOCK_FETCH', url: url.href });
        calls.push({ tool: 'search', url: url.href, query: url.searchParams.get('q') });
        return new Response(`<a class="result__a" href="${replacement}">MateBook D 14 官网</a><div class="result__snippet">D 14 官方产品介绍</div>`, { headers: { 'content-type': 'text/html' } });
      }
      if (c.id === 'C2' && url.href === replacement) {
        transport.push({ kind: 'EXPECTED_MOCK_FETCH', url: url.href });
        calls.push({ tool: 'readPage', url: url.href });
        return new Response('<title>MateBook D 14</title><p>MateBook D 14 产品介绍。</p><div class="product-buy-btn-price">¥5799起</div><li class="price_note">价格仅供参考，具体价格请以华为商城展示为准。</li>', { headers: { 'content-type': 'text/html' } });
      }
      unexpectedFetch++;
      transport.push({ kind: 'UNEXPECTED_MOCK_FETCH', url: url.href });
      throw new Error('OFFLINE: unexpected transport request prohibited');
    });
    try {
      if (c.id === 'C1') {
        const pageReads: string[] = [];
        const answer = await answerWebQuestion(c.input, '用户：查 MateBook Pro S 官网介绍', {
          previous: structuredClone(cached),
          search: async query => { calls.push({ tool: 'search', query }); return { ...structuredClone(cached), pages: undefined }; },
          readPage: async url => { pageReads.push(url); calls.push({ tool: 'readPage', url }); return { status: 'unavailable', url, readAt: '2026-10-22T00:00:00.000Z', title: '', text: '' }; },
          generate: async messages => { generated.push(messages); return { reply: '这次没有取得所选配置的报价。', sourceIds: ['WEB-SHOP'] }; },
        });
        result = { answer, pageReads };
        assert.ok(pageReads.includes(shop), '追问明确要求读商城，但商城读取次数为零');
        assert.deepEqual(pageReads, [shop], '只补读未读商城，不重复读取缓存产品页');
        assert.equal(calls.filter(call => (call as { tool: string }).tool === 'search').length, 0, '同产品可复用搜索');
      } else if (c.id === 'C2') {
        const session = newSession();
        session.lastWebSearch = structuredClone(cached);
        session.modelHistory = ['用户：查 MateBook Pro S 官网介绍'];
        const events: AgentEvent[] = [];
        await handleMessage(c.input, session, event => { events.push(structuredClone(event)); });
        result = { events, session, unexpectedFetch };
        const visible = events.filter(event => event.type === 'notice').map(event => 'text' in event ? event.text : '').join('\n');
        assert.doesNotMatch(visible, /7999|matebook-pro-s|MateBook Pro S/i, '明确更换为 D 14 后，仍返回 Pro S 的参考金额和来源');
        assert.equal(isWebFollowup(c.input, cached), true, '换产品仍由 agent 进入 web 入口');
        assert.equal(calls.filter(call => (call as { tool: string }).tool === 'search').length, 1, '换产品必须实际重新检索');
        assert.ok(calls.some(call => (call as { query?: string }).query?.includes('MateBook D 14')));
        assert.match(visible, /matebook-d-14/);
        assert.equal(transport.filter(entry => entry.kind === 'EXPECTED_MOCK_FETCH').length, 2);
      } else if (c.id === 'P1') {
        const answer = await answerWebQuestion(c.input, '', {
          previous: structuredClone(cached),
          search: async query => { calls.push({ tool: 'search', query }); return { ...structuredClone(cached), query, items: [{ id: 'WEB-D14', title: 'MateBook D 14 官网', url: replacement, snippet: 'MateBook D 14 产品介绍' }], pages: undefined }; },
          readPage: async url => { calls.push({ tool: 'readPage', url }); return { status: 'unavailable', url, readAt: '2026-10-22T00:00:00.000Z', title: '', text: '' }; },
          generate: async messages => { generated.push(messages); return { reply: '找到 D 14 的官方入口，但没有读到配置报价。', sourceIds: ['WEB-D14'] }; },
        });
        result = answer;
        assert.ok(calls.some(call => (call as { tool: string }).tool === 'search'));
        assert.match(answer.reply, /matebook-d-14/);
        assert.doesNotMatch(answer.reply, /7999|matebook-pro-s/);
      } else {
        const answer = await answerWebQuestion(c.input, '', {
          previous: structuredClone(cached),
          search: async () => { calls.push({ tool: 'unexpected-search' }); throw new Error('cache should suffice'); },
          readPage: async () => { calls.push({ tool: 'unexpected-read' }); throw new Error('cache should suffice'); },
          generate: async messages => { generated.push(messages); return { reply: '这是 MateBook Pro S 的产品介绍。', sourceIds: ['WEB-PROS'] }; },
        });
        result = answer;
        assert.equal(calls.length, 0);
        assert.match(answer.reply, /MateBook Pro S/);
      }
      assert.equal(unexpectedFetch, 0);
      save(id, { kind: 'SIMULATED_OFFLINE_ONLY', realHttpRequests: 0, case: c, status: 'passed', calls, transport, generated, result, unexpectedFetch });
    } catch (error) {
      // Preserve full output BEFORE propagating the failing assertion to the test runner.
      save(id, { kind: 'SIMULATED_OFFLINE_ONLY', realHttpRequests: 0, case: c, status: 'failed', calls, transport, generated, result, unexpectedFetch, error: errorValue(error) });
      throw error;
    }
  });
}
