// Real HTTP protocol adapted after reading user-journeys.live.mjs. Six questions only.
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const out = path.resolve(process.env.PARALLEL_PRICE_OUT || path.join(root, 'output/iterations/parallel-price-20261022'));
const scenarios = [
  { id: 'agent-pair', route: 'agent', turns: [
    '只用已有资料，介绍华为 MateBook Pro S 和 MateBook D 14 2024 的主要区别，不写价格。',
    '这两款比较价格。不要联网，分别说清已有报价的配置、日期和来源；没有对应报价就直说。',
    '我改口，不比较 D 14 了，只问刚才另一款的防窥版24GB/512GB多少钱。不要联网，不要拿柔光版价格代替。',
  ], criteria: [
    'Both exact products introduced; no unsolicited prices and no public-web tool call.',
    'Resolve both previous products; show a dated original price/source per product or an accurate explicit gap; neither silently omit a product nor mix SKUs. No public web.',
    'Resolve remaining product as Pro S; exclude D14 and soft-light price. Exact privacy-screen 24GB/512GB original record, date and source or explicit missing record. No public web.',
  ] },
  { id: 'consult-switch', route: 'consult', turns: [
    '联网查华为 MateBook Pro S 柔光版24GB/512GB现在官网多少钱，给实际来源。',
    '这次不用联网，我改口问 MateBook D 14 2024 的16GB/512GB价格，只用已有资料，没有这组配置就直说，别沿用刚才那款。',
    '那它换成24GB/512GB呢？仍不要联网，只说这组配置的价格，没有就直说。',
  ], criteria: [
    'Actual public search tool events plus returned real source; distinguish a general official reference from an exact-SKU current price and explicitly disclose the gap.',
    'No public web after revocation; D14 only; 16GB/512GB must be supported by original exact record or gap stated; general 5799 starting price cannot be exact SKU.',
    'Carry D14 model and replace capacity with 24GB/512GB; no Pro S revival or guessed SKU price, no public web.',
  ] },
];
await mkdir(out, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { startedAt: new Date().toISOString(), inputHash: hash(JSON.stringify(scenarios)), scenarios, questionBudget: 6, protocol: 'real localhost HTTP SSE; no mocked tools; no retries; no browser; transport completion is not user success; manual semantic review required', results: [] };
await writeFile(path.join(out, 'registration.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const snapshot = async () => Object.fromEntries(await Promise.all(tracked.map(async file => [file, await readFile(path.join(root, file)).then(hash, () => 'absent')])));
const before = await snapshot();
await writeFile(path.join(out, 'tracked-before.json'), JSON.stringify(before, null, 2), { flag: 'wx' });
await writeFile(path.join(out, 'status-before.txt'), execFileSync('git', ['status', '--short'], { cwd: root }), { flag: 'wx' });
for (const scenario of scenarios) {
  const sessionId = `s-${randomUUID()}`;
  for (let index = 0; index < scenario.turns.length; index++) {
    const stem = `${scenario.id}-${index + 1}`;
    const entry = { id: stem, route: scenario.route, sessionId, message: scenario.turns[index], criterion: scenario.criteria[index], events: [] };
    report.results.push(entry);
    const started = Date.now();
    const request = { sessionId, message: entry.message };
    await writeFile(path.join(out, `${stem}.request.json`), JSON.stringify(request, null, 2), { flag: 'wx' });
    await writeFile(path.join(out, `${stem}.sse`), '', { flag: 'wx' });
    try {
      const response = await fetch(`http://127.0.0.1:3100/api/${scenario.route}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(request), signal: AbortSignal.timeout(240000) });
      entry.http = response.status;
      entry.contentType = response.headers.get('content-type');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const frame = data => {
        const payload = data.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (payload) entry.events.push({ ...JSON.parse(payload), elapsedMs: Date.now() - started });
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        await appendFile(path.join(out, `${stem}.sse`), value);
        buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) { frame(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
      }
      buffer += decoder.decode();
      if (buffer.trim()) frame(buffer);
      entry.reply = entry.events.filter(e => e.type === 'notice').map(e => e.text).join('\n') || entry.events.findLast(e => e.type === 'answer')?.answer?.reply || '';
      entry.tools = entry.events.filter(e => e.type === 'tool');
      entry.runStatus = entry.events.findLast(e => e.type === 'done')?.run?.status;
      entry.semanticVerdict = 'pending manual review';
    } catch (error) { entry.error = String(error.message); }
    entry.ms = Date.now() - started;
    await writeFile(path.join(out, `${stem}.json`), JSON.stringify(entry, null, 2), { flag: 'wx' });
    await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ id: entry.id, http: entry.http, status: entry.runStatus, ms: entry.ms, reply: entry.reply, tools: entry.tools, error: entry.error }));
  }
}
const after = await snapshot();
await writeFile(path.join(out, 'tracked-after.json'), JSON.stringify(after, null, 2), { flag: 'wx' });
await writeFile(path.join(out, 'tracked-difference.json'), JSON.stringify(tracked.filter(file => before[file] !== after[file]), null, 2), { flag: 'wx' });
report.endedAt = new Date().toISOString();
await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
