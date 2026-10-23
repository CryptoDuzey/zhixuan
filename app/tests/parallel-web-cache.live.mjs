// Real HTTP/SSE follow-ups; source snapshots are read only for test evidence.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const output = path.resolve(process.env.CACHE_LIVE_OUT || path.join(root, 'output/iterations/parallel-web-cache-20261022'));
await mkdir(output, { recursive: true });
const scenarios = [
  { id: 'switch', turns: ['联网查华为 MateBook Pro S 官网介绍，简短回答。', '把刚才查到的换成 MateBook D 14，告诉我官网价格。'] },
  { id: 'shop', turns: ['联网查华为 MateBook Pro S 官网介绍和商城入口，先不写价格。', '那刚才查到的 MateBook Pro S 24GB/512GB 柔光版多少钱？请读商城报价。'] },
];
const report = { inputHash: createHash('sha256').update(JSON.stringify(scenarios)).digest('hex'), scenarios,
  criteria: ['switch follow-up actually searches; no previous Pro S amount/link', 'shop follow-up reads a previously unread returned merchant URL; if search returned no merchant, label not covered rather than pass', 'no reference price is presented as an exact-SKU transaction price'], results: [] };
await writeFile(path.join(output, 'registration.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
for (let round = 1; round <= 2; round++) for (const scenario of scenarios) {
  const sessionId = `s-${randomUUID()}`;
  for (let index = 0; index < scenario.turns.length; index++) {
    const row = { id: `R${round}/${scenario.id}/${index + 1}`, sessionId, message: scenario.turns[index], events: [] };
    try {
      const response = await fetch('http://127.0.0.1:3100/api/agent', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ sessionId, message: row.message }), signal: AbortSignal.timeout(240000) });
      row.http = response.status;
      const wire = await response.text();
      for (const frame of wire.replaceAll('\r\n', '\n').split('\n\n')) {
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) row.events.push(JSON.parse(data));
      }
      row.reply = row.events.filter(event => event.type === 'notice').map(event => event.text).join('\n');
      row.status = row.events.findLast(event => event.type === 'done')?.run?.status;
      const saved = JSON.parse(await readFile(path.join(root, 'app/data/private/sessions', `${sessionId}.json`), 'utf8'));
      row.actualSearch = saved.session?.lastWebSearch;
    } catch (error) { row.error = error.message; }
    report.results.push(row);
    await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ id: row.id, status: row.status, reply: row.reply, error: row.error }));
  }
}
