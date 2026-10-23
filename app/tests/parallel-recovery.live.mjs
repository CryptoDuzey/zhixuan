// Real HTTP cancellation/readback only; does not mock services or inspect UI.
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';

const output = path.resolve('../output/iterations/parallel-round-20261022/recovery');
await mkdir(output, { recursive: true });
const results = [];
for (const route of ['agent', 'consult']) {
  const sessionId = `parallel-stop-${randomUUID()}`;
  const record = { route, sessionId, message: '联网查一下华为 MateBook Pro S 官网产品介绍，简单说说。', events: [] };
  const response = await fetch(`http://127.0.0.1:3100/api/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ sessionId, message: record.message }), signal: AbortSignal.timeout(90000),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', stopped = false;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    pending += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
    for (let end; (end = pending.indexOf('\n\n')) !== -1;) {
      const frame = pending.slice(0, end); pending = pending.slice(end + 2);
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      const event = JSON.parse(data); record.events.push(event);
      if (!stopped && event.type === 'run' && event.run?.id) {
        stopped = true;
        const cancellation = await fetch(`http://127.0.0.1:3100/api/${route}/cancel`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, runId: event.run.id }),
        });
        record.cancelStatus = cancellation.status;
        record.cancelBody = await cancellation.json();
      }
    }
  }
  const readback = await fetch(`http://127.0.0.1:3100/api/${route}?sessionId=${sessionId}`);
  record.readbackStatus = readback.status;
  record.saved = await readback.json();
  results.push(record);
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  assert.equal(record.cancelStatus, 202);
  assert.equal(record.events.findLast(event => event.type === 'done')?.run?.status, 'cancelled');
  assert.equal(record.saved.busy, false);
  assert.equal(record.saved.run.status, 'cancelled');
  assert.ok(route === 'agent' ? record.saved.messages.some(item => item.role === 'user' && item.text === record.message)
    : record.saved.turns.some(item => item.question === record.message));
  console.log(`${route}: cancelled, not busy, question saved`);
}
