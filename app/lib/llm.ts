// 网关客户端：本机设置即时生效，环境变量保留为默认配置和回退链。
import { consumeModelGateway, getModelSettings, ModelSettingsError, publicModelError } from './model-settings.ts';
import type { ModelSettings } from './model-settings.ts';
import { abortableDelay, reportModel, reportTool, runSignal, throwIfStopped, useModelAttempt } from './agent-runtime.ts';
import { randomUUID } from 'node:crypto';
import { consumeCompletion, previewString, type CompletionMode } from './model-stream.ts';
import { completionOptions } from './model-settings.ts';

export interface LlmCall {
  at: string;
  model: string;
  purpose: string;
  ok: boolean;
  ms: number;
  attempt: number;
  note?: string;
}
const calls: LlmCall[] = [];
export const getLlmCalls = () => calls;

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmOpts {
  purpose: string;
  temperature?: number;
  maxTokens?: number;
  reasoning?: 'low';
  json?: boolean;
  models?: string[];
  timeoutMs?: number;
  preview?: { field: 'reply'; kind: 'answer' } | { field: 'body'; kind: 'draft' };
}

function toolLabel(purpose: string) {
  const action = purpose.split('/')[0];
  const labels: Record<string, string> = { understand: '理解创作需求', write: '撰写平台稿件', revise: '按要求改稿', verify: '核验事实与配图', consult: '整理选购建议' };
  return (labels[action] ?? '处理当前任务') + (purpose.endsWith('/json-retry') ? '（修正回复格式）' : '');
}

async function once(settings: ModelSettings, model: string, messages: ChatMsg[], o: LlmOpts, callId: string): Promise<string> {
  let lastAt = 0;
  let lastCharacters = 0;
  let lastText = '';
  const publish = (text: string, mode: CompletionMode, force = false) => {
    throwIfStopped();
    if (!force && Date.now() - lastAt < 80 && !(text.length && lastCharacters === 0)) return;
    lastAt = Date.now();
    lastCharacters = text.length;
    reportModel({ type: 'model_progress', callId, characters: text.length, mode });
    if (o.preview) {
      const visible = previewString(text, o.preview.field);
      if (visible && visible !== lastText) {
        lastText = visible;
        reportModel({ type: 'model_preview', callId, kind: o.preview.kind, text: visible, status: 'generating' });
      }
    }
  };
  const providerOptions = completionOptions(settings, model, o.reasoning);
  const maxTokens = providerOptions.thinking?.type === 'enabled' ? Math.max(o.maxTokens ?? 4000, 8192) : o.maxTokens ?? 4000;
  const result = await consumeModelGateway(settings, 'chat/completions', {
    method: 'POST',
    signal: runSignal(),
    body: JSON.stringify({ model, messages, temperature: o.temperature ?? 0.4, max_tokens: maxTokens, stream: true, ...providerOptions }),
  }, o.timeoutMs ?? 120_000, (response, signal) => consumeCompletion(response, signal, publish));
  throwIfStopped();
  publish(result.text, result.mode, true);
  return result.text;
}

function discard(callId: string, o: LlmOpts) {
  if (o.preview) reportModel({ type: 'model_preview', callId, kind: o.preview.kind, text: '', status: 'discarded' });
}

/** Transient errors retry; account failures stop and model-specific rejections advance. */
async function chatWithCallId(messages: ChatMsg[], o: LlmOpts): Promise<{ text: string; model: string; callId: string }> {
  const settings = getModelSettings();
  let lastErr = '';
  for (const model of o.models ?? settings.models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      useModelAttempt();
      const t0 = Date.now();
      const callId = randomUUID();
      reportTool({ type: 'tool', tool: 'model', status: 'started', label: toolLabel(o.purpose) });
      try {
        const text = await once(settings, model, messages, o, callId);
        calls.push({ at: new Date().toISOString(), model, purpose: o.purpose, ok: true, ms: Date.now() - t0, attempt });
        if (calls.length > 500) calls.shift();
        reportTool({ type: 'tool', tool: 'model', status: 'completed', label: toolLabel(o.purpose), ms: Date.now() - t0 });
        return { text, model, callId };
      } catch (e: unknown) {
        throwIfStopped();
        discard(callId, o);
        const error = publicModelError(e);
        lastErr = error.message;
        calls.push({ at: new Date().toISOString(), model, purpose: o.purpose, ok: false, ms: Date.now() - t0, attempt, note: lastErr.slice(0, 120) });
        if (calls.length > 500) calls.shift();
        reportTool({ type: 'tool', tool: 'model', status: 'failed', label: toolLabel(o.purpose), ms: Date.now() - t0 });
        if (error.code === 'quota_exhausted' || error.status === 401 || error.status === 402) throw error;
        if ([400, 403, 404, 422].includes(error.status)) break;
        await abortableDelay(600 * attempt);
      }
    }
  }
  throw new ModelSettingsError(502, `模型调用失败：${lastErr}`);
}

export async function chat(messages: ChatMsg[], o: LlmOpts): Promise<{ text: string; model: string }> {
  const { text, model } = await chatWithCallId(messages, o);
  return { text, model };
}

export function extractJson<T = any>(text: string): T {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const s = body.indexOf('{');
  const e = body.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('响应中没有 JSON');
  return JSON.parse(body.slice(s, e + 1));
}

/** 要求 JSON 输出；解析失败时带错误信息重试一次。 */
export async function chatJson<T = any>(messages: ChatMsg[], o: LlmOpts): Promise<{ data: T; model: string }> {
  const first = await chatWithCallId(messages, o);
  try {
    return { data: extractJson<T>(first.text), model: first.model };
  } catch (err: any) {
    discard(first.callId, o);
    const retry = await chatWithCallId(
      [...messages, { role: 'assistant', content: first.text }, { role: 'user', content: `上一条不是合法 JSON（${err.message}）。只输出一个 JSON 对象，不要任何其他文字。` }],
      { ...o, purpose: `${o.purpose}/json-retry` },
    );
    try {
      return { data: extractJson<T>(retry.text), model: retry.model };
    } catch (error) {
      discard(retry.callId, o);
      throw error;
    }
  }
}
