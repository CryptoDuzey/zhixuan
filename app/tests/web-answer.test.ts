import test from 'node:test';
import assert from 'node:assert/strict';
import { answerWebQuestion, webQuery, isWebFollowup } from '../lib/web-answer.ts';
import type { WebSearchResult } from '../lib/web-search.ts';
import { wantsWebSearch } from '../lib/web-search.ts';
const found = { status: 'ready', query: '电脑', searchedAt: '2026-10-21', provider: 'bing', items: [{ id: 'W1', title: '真实页面', url: 'https://consumer.huawei.com/cn/', snippet: '历史发布价，不是现价' }] } as WebSearchResult;
test('代词询价只携带用户产品上下文，不向搜索发送内部资料和助手历史', () => {
  const query = webQuery('联网搜这个现在多少钱', '用户：华为 MateBook Pro S 什么电脑\n助手：private document secret\n用户：那它多少钱');
  assert.match(query, /MateBook Pro S/); assert.doesNotMatch(query, /private|secret/);
});
test('联网回答只附实际工具来源，不采用模型虚构链接', async () => {
  const result = await answerWebQuestion('联网查价格', '', { search: async () => found, generate: async () => ({ reply: '这是历史价格。https://invented.example/price', sourceIds: ['fake', 'W1'] }) });
  assert.match(result.reply, /https:\/\/consumer.huawei.com/); assert.doesNotMatch(result.reply, /invented/);
});
test('搜索失败不调用模型伪造结果，空结果和连不上分别说明', async () => {
  for (const status of ['empty', 'unavailable'] as const) {
    const result = await answerWebQuestion('联网', '', { search: async () => ({ ...found, status, items: [] }), generate: async () => { throw new Error('must not call'); } });
    assert.match(result.reply, status === 'empty' ? /没有搜到/ : /没连上/); assert.doesNotMatch(result.reply, /已查到/);
  }
});
test('已查结果的措辞追问沿用实际搜索，明确禁止联网不算搜索续接', async () => {
  assert.equal(isWebFollowup('把刚才查到的说得自然一点', found), true);
  assert.equal(isWebFollowup('不要联网，只用已有资料', found), false);
  const result = await answerWebQuestion('刚才查到的重点', '', { previous: found, search: async () => { throw new Error('no duplicate'); }, generate: async () => ({ reply: '重点', sourceIds: ['W1'] }) });
  assert.match(result.reply, /真实页面/);
});
test('查官网时已有官方页面，不把百科中的代次和系统混入回答上下文', async () => {
  const mixed = { ...found, items: [...found.items, { id: 'W2', title: '百科', url: 'https://zh.wikipedia.org/wiki/product', snippet: '另一个代次' }] };
  const result = await answerWebQuestion('帮我搜索官网介绍', '', { search: async () => mixed, generate: async messages => {
    assert.doesNotMatch(messages[1].content, /另一个代次/);
    return { reply: '官网有介绍页。', sourceIds: ['W2', 'W1'] };
  } });
  assert.doesNotMatch(result.reply, /wikipedia/);
});
test('自然询问现在多少钱会查询，明确不要联网则仍尊重资料范围', () => {
  assert.equal(wantsWebSearch('MateBook Pro S现在多少钱'), true);
  assert.equal(wantsWebSearch('网上找一下这款的价格'), true);
  assert.equal(wantsWebSearch('不要联网，只用已有资料说现在多少钱'), false);
});
test('实际官网参考金额直接按原展示交付，不让模型加起或冒充配置报价', async () => {
  const sources = { ...found, items: [{ ...found.items[0], url: 'https://consumer.huawei.com/cn/harmonyos-computer/matebook-pro-s/' }] };
  const result = await answerWebQuestion('官网现在多少钱', '', { search: async () => sources,
    readPage: async url => ({ status: 'ready', url, readAt: '2026-10-21T10:00:00Z', title: '官网', text: '参考价', referencePrice: { amount: 7999, display: '¥7999', currency: 'CNY', note: '价格仅供参考，具体价格请以华为商城展示为准。', sourceUrl: url, kind: 'page-reference', isTransactionPrice: false, hidden: true, disclaimer: '非成交价' } }),
    generate: async () => { throw new Error('Do not rewrite numeric quote with a model'); },
  });
  assert.match(result.reply, /¥7999/); assert.doesNotMatch(result.reply, /7999\s*起/);
  assert.match(result.reply, /不是.*成交价|非.*成交价/); assert.match(result.reply, /2026-10-21/);
});
test('模型在正文末尾擅自输出链接时，删除整段链接引导，不留下空冒号和分号', async () => {
  const result = await answerWebQuestion('查介绍', '', { search: async () => found, generate: async () => ({ reply: '这是一台折叠电脑。来源链接：https://invented.example/；规格页：https://invented.example/specs', sourceIds: ['W1'] }) });
  assert.match(result.reply, /这是一台折叠电脑/); assert.doesNotMatch(result.reply, /来源链接[：:]|规格页[：:]|invented/);
});
test('只查产品介绍时，不把隐藏参考价及内部价格处置指令送进正文回答', async () => {
  const result = await answerWebQuestion('查官网介绍', '', { search: async () => ({ ...found, items: [{ ...found.items[0], url: 'https://consumer.huawei.com/cn/harmonyos-computer/matebook-pro-s/' }] }), readPage: async url => ({ status: 'ready', url, readAt: '2026-10-21', title: '官网', text: '【网页参考价；隐藏内容】¥7999。不是成交价\n产品是轻薄本。' }), generate: async messages => {
    assert.doesNotMatch(messages[1].content, /7999/);
    assert.match(messages[1].content, /轻薄本/);
    return { reply: '这是一款轻薄本。', sourceIds: ['W1'] };
  } });
  assert.doesNotMatch(result.reply, /价格|报价|7999/);
});
