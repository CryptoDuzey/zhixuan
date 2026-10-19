// 网关客户端：本机设置即时生效，环境变量保留为默认配置和回退链。
import { fetchModelGateway, getModelSettings, ModelSettingsError, publicModelError } from './model-settings.ts';
import type { ModelSettings } from './model-settings.ts';
import { abortableDelay, reportTool, runSignal, throwIfStopped, useModelAttempt } from './agent-runtime.ts';

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
  json?: boolean;
  models?: string[];
  timeoutMs?: number;
}

function toolLabel(purpose: string) {
  const action = purpose.split('/')[0];
  const labels: Record<string, string> = { understand: '理解创作需求', write: '撰写平台稿件', revise: '按要求改稿', verify: '核验事实与配图', consult: '整理选购建议' };
  return (labels[action] ?? '处理当前任务') + (purpose.endsWith('/json-retry') ? '（修正回复格式）' : '');
}

async function once(settings: ModelSettings, model: string, messages: ChatMsg[], o: LlmOpts): Promise<string> {
  const j = await fetchModelGateway(settings, 'chat/completions', {
    method: 'POST',
    signal: runSignal(),
    body: JSON.stringify({ model, messages, temperature: o.temperature ?? 0.4, max_tokens: o.maxTokens ?? 4000 }),
  }, o.timeoutMs ?? 120_000) as { choices?: { message?: { content?: unknown } }[] } | null;
  const c = j?.choices?.[0]?.message?.content;
  throwIfStopped();
  if (typeof c !== 'string' || !c.trim()) throw new ModelSettingsError(502, '模型网关没有返回有效回复。');
  return c;
}

/** 依次尝试模型链；每个模型最多 2 次。返回文本与实际使用的模型。 */
export async function chat(messages: ChatMsg[], o: LlmOpts): Promise<{ text: string; model: string }> {
  const settings = getModelSettings();
  let lastErr = '';
  for (const model of o.models ?? settings.models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      useModelAttempt();
      const t0 = Date.now();
      reportTool({ type: 'tool', tool: 'model', status: 'started', label: toolLabel(o.purpose) });
      try {
        const text = await once(settings, model, messages, o);
        calls.push({ at: new Date().toISOString(), model, purpose: o.purpose, ok: true, ms: Date.now() - t0, attempt });
        if (calls.length > 500) calls.shift();
        reportTool({ type: 'tool', tool: 'model', status: 'completed', label: toolLabel(o.purpose), ms: Date.now() - t0 });
        return { text, model };
      } catch (e: unknown) {
        throwIfStopped();
        lastErr = publicModelError(e).message;
        calls.push({ at: new Date().toISOString(), model, purpose: o.purpose, ok: false, ms: Date.now() - t0, attempt, note: lastErr.slice(0, 120) });
        if (calls.length > 500) calls.shift();
        reportTool({ type: 'tool', tool: 'model', status: 'failed', label: toolLabel(o.purpose), ms: Date.now() - t0 });
        await abortableDelay(600 * attempt);
      }
    }
  }
  throw new Error(`模型调用失败：${lastErr}`);
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
  const first = await chat(messages, o);
  try {
    return { data: extractJson<T>(first.text), model: first.model };
  } catch (err: any) {
    const retry = await chat(
      [...messages, { role: 'assistant', content: first.text }, { role: 'user', content: `上一条不是合法 JSON（${err.message}）。只输出一个 JSON 对象，不要任何其他文字。` }],
      { ...o, purpose: `${o.purpose}/json-retry` },
    );
    return { data: extractJson<T>(retry.text), model: retry.model };
  }
}
