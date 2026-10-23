// Real HTTP + real models/tools. Inputs remain fixed across before/after runs.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
const primary = [
  { id: 'product', route: 'agent', turns: [
    '华为 MateBook Pro S 是什么电脑？适合什么人，直接说重点。',
    '那它多少钱？把你知道的配置和价格告诉我。',
    '你联网搜一下现在官网卖多少钱，给我链接，不要只让我自己去查。',
  ] },
  { id: 'price-d14', route: 'agent', turns: ['华为 MateBook D 14 2024 多少钱？有历史资料也可以，说明是哪一款配置。'] },
  { id: 'web', route: 'agent', turns: ['帮我联网搜索华为 MateBook Fold 非凡大师的官网介绍，给我来源链接。', '把刚才查到的重点说得像正常聊天，不要说可复查、已核查、证据或发现卡。'] },
  { id: 'consult-price', route: 'consult', turns: ['华为 MateBook Pro S 多少钱？我问的就是价格，不需要先问用途。', '联网查一下这个型号现在的价格，给来源。'] },
  { id: 'no-web', route: 'agent', turns: ['不要联网，只用已有资料说说 MateBook Pro S 标准屏和柔光屏的重量区别。'] },
];
const boundaries = [
  { id: 'mouse', route: 'consult', turns: ['华为无线鼠标 3 多少钱？用已有价格资料回答就行。'] },
  { id: 'display', route: 'agent', turns: ['华为 MateView GT 27 英寸高刷版多少钱？有历史记录也可以。'] },
  { id: 'sku', route: 'agent', turns: ['MateBook Pro S 柔光屏24GB 512GB多少钱？只说这个配置。'] },
  { id: 'unknown', route: 'agent', turns: ['MateBook 幻影2099 的售价和续航是多少？没有资料就直接说，别用相似型号代替。'] },
];
const capacityAliases = [
  { id: 'alias-agent', route: 'agent', turns: ['MateBook Pro S 柔光版２４Ｇ ５１２Ｇ多少钱？只用已有资料。'] },
  { id: 'missing-agent', route: 'agent', turns: ['MateBook Pro S 柔光版124GB 512GB多少钱？只用已有资料，没有这款就直接说。'] },
  { id: 'alias-consult', route: 'consult', turns: ['MateBook Pro S 柔光版24G 512G多少钱？只用已有资料。'] },
  { id: 'missing-consult', route: 'consult', turns: ['MateBook Pro S 柔光版124GB 512GB多少钱？只用已有资料，没有这款就直接说。'] },
];
const hybrid = [{ id: 'web-then-create', route: 'agent', turns: ['先联网搜索 MateBook Pro S 的官网介绍，然后按已有产品资料写一条朋友圈，面向通勤办公的人。正文150—250字，只用2张现有图库图片，不生成新图，不写价格优惠或亲测。'] }];
const scenarios = process.env.JOURNEYS_HYBRID === '1' ? hybrid : process.env.JOURNEYS_ALIASES === '1' ? capacityAliases : process.env.JOURNEYS_BOUNDARIES === '1' ? boundaries : primary;
const out = path.resolve(process.env.JOURNEYS_OUT || '../output/iterations/user-journeys-baseline-20261021');
await mkdir(out, { recursive: true });
const target = path.join(out, 'results.json');
if (await access(target).then(() => true, () => false)) throw new Error('Refusing to overwrite results');
const report = { startedAt: new Date().toISOString(), inputHash: createHash('sha256').update(JSON.stringify(scenarios)).digest('hex'), scenarios, results: [], protocol: 'real HTTP SSE, real model and tool requests; semantic answers require manual reading' };
await writeFile(target, JSON.stringify(report, null, 2));
const repeats = Number(process.env.JOURNEYS_REPEATS || 2);
const selected = scenarios.filter(scenario => !process.env.JOURNEYS_FILTER || scenario.id === process.env.JOURNEYS_FILTER);
// Independent conversations, sequential turns within each conversation.
for (let round = 1; round <= repeats; round++) {
  for (let offset = 0; offset < selected.length; offset += 2) {
    await Promise.all(selected.slice(offset, offset + 2).map(async scenario => {
      const sessionId = `s-${randomUUID()}`;
      for (let index = 0; index < scenario.turns.length; index++) {
        const message = scenario.turns[index];
        const started = Date.now();
        const entry = { round, scenario: scenario.id, turn: index + 1, sessionId, message, events: [] };
        report.results.push(entry);
        try {
          const response = await fetch(`http://127.0.0.1:3100/api/${scenario.route}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ sessionId, message }), signal: AbortSignal.timeout(240000) });
          entry.http = response.status;
          entry.contentType = response.headers.get('content-type');
          const reader = response.body.getReader();
          let buffer = ''; const decoder = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              if (data) entry.events.push({ ...JSON.parse(data), elapsedMs: Date.now() - started });
            }
          }
          entry.status = entry.events.findLast(event => event.type === 'done')?.run?.status;
          entry.reply = entry.events.filter(event => event.type === 'notice').map(event => event.text).join('\n') || entry.events.findLast(event => event.type === 'answer')?.answer?.reply || '';
          // Consult uses answer event containing the result object directly.
          if (!entry.reply) entry.reply = entry.events.findLast(event => event.reply)?.reply || entry.events.findLast(event => event.type === 'done')?.answer?.reply || '';
          entry.previews = new Set(entry.events.filter(event => event.type === 'model_preview' && event.status === 'generating').map(event => event.text)).size;
          entry.tools = entry.events.filter(event => event.type === 'tool');
          entry.draft = entry.events.findLast(event => event.type === 'done')?.view?.draft;
          entry.checks = { completed: entry.status === 'completed', conversational: !/可复查|可核实|已核查|已核验|发现卡|证据编号|核验通过/.test(entry.reply), pricePresent: /\d[\d,.]*\s*元|[¥￥]\s*\d/.test(entry.reply), linkPresent: /https?:\/\//.test(entry.reply), webCalled: entry.tools.some(event => /联网|网页|互联网/.test(event.label)), webSucceeded: entry.tools.some(event => event.status === 'completed' && /已搜索公开网页/.test(event.label)), webReadSucceeded: entry.tools.some(event => event.status === 'completed' && /已读取官方网页/.test(event.label)) };
        } catch (error) { entry.error = String(error.message); }
        entry.ms = Date.now() - started;
        console.log(JSON.stringify({ round, scenario: entry.scenario, turn: entry.turn, status: entry.status, ms: entry.ms, reply: entry.reply, checks: entry.checks, error: entry.error }));
      }
    }));
    await writeFile(target, JSON.stringify(report, null, 2));
  }
}
report.endedAt = new Date().toISOString();
await writeFile(target, JSON.stringify(report, null, 2));
