import { ModelSettingsError } from './model-settings.ts';

export type CompletionMode = 'stream' | 'buffered';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 256 * 1024;
const MAX_EVENT = 128 * 1024;
const invalid = () => new ModelSettingsError(502, '模型回复未完整完成，请重试；未完成的预览不会保存。');

/** Decode the gateway protocol, never exposing reasoning, tool calls or error bodies. */
export async function consumeCompletion(
  response: Response,
  signal: AbortSignal,
  onContent: (text: string, mode: CompletionMode) => void,
): Promise<{ text: string; mode: CompletionMode }> {
  const mode: CompletionMode = response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ? 'stream' : 'buffered';
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  let bytes = 0;
  let text = '';
  let pending = '';
  let finished = false;
  let ended = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const check = () => { if (signal.aborted) throw signal.reason; };
  const append = (delta: unknown) => {
    if (delta === undefined || delta === null || delta === '') return;
    if (typeof delta !== 'string' || finished || ended) throw invalid();
    text += delta;
    if (text.length > MAX_TEXT) throw invalid();
    check();
    onContent(text, mode);
  };
  const event = (block: string) => {
    if (block.length > MAX_EVENT) throw invalid();
    const data = block.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return; // comments, keepalives and other SSE metadata
    if (data.trim() === '[DONE]') {
      if (!finished || ended) throw invalid();
      ended = true;
      return;
    }
    if (ended) throw invalid();
    let value: any;
    try { value = JSON.parse(data); } catch { throw invalid(); }
    if (value?.error) throw invalid();
    const choice = value?.choices?.find((item: any) => item?.index === 0)
      ?? (value?.choices?.length === 1 && value.choices[0]?.index === undefined ? value.choices[0] : undefined);
    if (!choice) return; // usage-only tail
    if (choice.delta?.tool_calls || choice.delta?.function_call) throw invalid();
    append(choice.delta?.content);
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (finished || choice.finish_reason !== 'stop') throw invalid();
      finished = true;
    }
  };
  try {
    check();
    onContent('', mode);
    for (;;) {
      const chunk = await reader.read();
      check();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw invalid();
      pending += decoder.decode(chunk.value, { stream: true });
      if (mode === 'stream') {
        // Normalize CRLF only after its second byte arrives.
        pending = pending.replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          event(pending.slice(0, boundary));
          pending = pending.slice(boundary + 2);
        }
        if (pending.length > MAX_EVENT) throw invalid();
        if (ended) break;
      }
    }
    pending += decoder.decode();
    if (mode === 'stream') {
      if (pending.trim()) event(pending.replace(/\r\n/g, '\n'));
      if (!finished) throw invalid(); // EOF alone must never turn a truncated answer into success.
    } else {
      let value: any;
      try { value = JSON.parse(pending); } catch { throw invalid(); }
      if (value?.error) throw invalid();
      const choice = value?.choices?.[0];
      if (choice?.finish_reason != null && choice.finish_reason !== 'stop') throw invalid();
      if (choice?.message?.tool_calls || choice?.message?.function_call) throw invalid();
      append(choice?.message?.content);
    }
    check();
    if (!text.trim()) throw invalid();
    return { text, mode };
  } finally {
    signal.removeEventListener('abort', abort);
    // Closing the local reader is synchronous; the transport's cleanup promise
    // may never settle. Do not let it hold a finished answer or stop request open.
    try { void reader.cancel().catch(() => {}); } catch { /* Closed or aborted. */ }
    reader.releaseLock();
  }
}

function readString(text: string, start: number) {
  let value = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return { value, end: i + 1, complete: true };
    if (c.charCodeAt(0) < 32) return null;
    if (c !== '\\') { value += c; continue; }
    const escape = text[++i];
    if (escape === undefined) break;
    if (escape === 'u') {
      const hex = text.slice(i + 1, i + 5);
      if (hex.length < 4) break;
      if (!/^[0-9a-f]{4}$/i.test(hex)) return null;
      value += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else {
      const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (!(escape in escapes)) return null;
      value += escapes[escape];
    }
  }
  // A Unicode surrogate split across chunks is not yet displayable.
  return { value: value.replace(/[\uD800-\uDBFF]$/, ''), end: text.length, complete: false };
}

/** Allow only an explicitly selected top-level user-facing JSON string. */
export function previewString(text: string, field: 'reply' | 'body'): string {
  const prefix = text.match(/^\s*(?:```(?:json)?\s*)?\{/);
  if (!prefix) return '';
  let depth = 1;
  let keyExpected = true;
  for (let i = prefix[0].length; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const parsed = readString(text, i);
      if (!parsed || !parsed.complete) return '';
      if (depth === 1 && keyExpected) {
        let cursor = parsed.end;
        while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
        if (text[cursor++] !== ':') return '';
        while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
        if (parsed.value === field) {
          if (text[cursor] !== '"') return '';
          return (readString(text, cursor)?.value ?? '').slice(0, 12_000);
        }
        keyExpected = false;
      }
      i = parsed.end - 1;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { if (--depth === 0) return ''; }
    else if (c === ',' && depth === 1) keyExpected = true;
  }
  return '';
}
