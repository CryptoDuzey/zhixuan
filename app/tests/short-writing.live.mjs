// Actual HTTP/SSE with real models and local KB; private fixed histories, no mocks.
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const stage = process.argv[2];
if (!/^(baseline|after-r1|after-r2)$/.test(stage ?? '')) throw Error('Explicit stage required');
const out = path.join(root, 'output/iterations/short-writing-20261023', stage);
await mkdir(out, { recursive: true });
const original = JSON.parse(await readFile(path.join(root, 'output/iterations/experience-integration-20261023/creation-ui-failure-full-session.json'), 'utf8'));
const prefix = original.messages.slice(0, 4);
const task = original.messages[4].text;
const cases = [
  { id: 'short', message: task, min: 60, max: 100 },
  { id: 'normal', message: task.replace('60至100字', '90至150字'), min: 90, max: 150 },
  { id: 'expanded', message: task.replace('60至100字', '150至250字'), min: 150, max: 250 },
];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const registration = { inputHash: hash({ prefix, cases }), prefix, cases, repeats: 2,
  success: 'Short length compliance improves across both repetitions; normal and expanded controls retain valid delivery; no new unsupported effects, missing mandatory fact conditions, cross-model images or duplicate images. Review each delivered draft; empty drafts and error responses fail. Do not treat blocked report as publishable.' };
await writeFile(path.join(out, 'registration.json'), JSON.stringify(registration, null, 2), { flag: 'wx' });
const report = { stage, registration, results: [] };
for (let repeat = 1; repeat <= 2; repeat++) for (const sample of cases) {
  const sessionId = `s-${randomUUID()}`;
  const saved = { schema: 1, session: { modelId: '', modelName: '' }, messages: prefix, calls: [], busy: false, interrupted: false, updatedAt: new Date().toISOString() };
  await writeFile(path.join(root, 'app/data/private/sessions', `${sessionId}.json`), JSON.stringify(saved), { flag: 'wx' });
  const stem = `${sample.id}-${repeat}`, entry = { id: stem, sessionId, message: sample.message, events: [], previews: [] };
  report.results.push(entry);
  const start = Date.now();
  try {
    const response = await fetch('http://127.0.0.1:3100/api/agent', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ sessionId, message: sample.message }), signal: AbortSignal.timeout(240000) });
    entry.http = response.status;
    await writeFile(path.join(out, `${stem}.sse`), '', { flag: 'wx' });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    const frame = block => {
      const text = block.split('\n').filter(s => s.startsWith('data:')).map(s => s.slice(5).trimStart()).join('\n');
      if (text) entry.events.push(JSON.parse(text));
    };
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      await appendFile(path.join(out, `${stem}.sse`), value);
      pending += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      let end; while ((end = pending.indexOf('\n\n')) >= 0) { frame(pending.slice(0, end)); pending = pending.slice(end + 2); }
    }
    if (pending.trim()) frame(pending);
    const previews = new Map();
    for (const event of entry.events) if (event.type === 'model_preview' && event.kind === 'draft' && event.text) previews.set(event.callId, event.text);
    entry.previews = [...previews].map(([callId, body]) => ({ callId, body, length: [...body].length }));
    const record = JSON.parse(await readFile(path.join(root, 'app/data/private/sessions', `${sessionId}.json`), 'utf8'));
    await writeFile(path.join(out, `${stem}.session.json`), JSON.stringify(record, null, 2), { flag: 'wx' });
    entry.draft = record.session.draft;
    entry.check = record.session.report;
    entry.run = record.run;
    entry.length = [...(entry.draft?.body ?? '')].length;
    entry.lengthPassed = Boolean(entry.draft && entry.length >= sample.min && entry.length <= sample.max);
    entry.errors = entry.events.filter(e => e.type === 'error').map(e => e.text);
    entry.manualVerdict = 'pending';
  } catch (error) { entry.error = error.message; }
  entry.ms = Date.now() - start;
  await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ id: stem, http: entry.http, length: entry.length, lengthPassed: entry.lengthPassed, previews: entry.previews, errors: entry.errors, ms: entry.ms }));
}
