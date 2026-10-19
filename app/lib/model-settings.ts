import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api.openai-next.com/v1';
const DEFAULT_MODELS = 'claude-opus-5-5,claude-haiku-4-5';

export interface ModelSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  models: string[];
}

export interface ModelSettingsInput {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

/** Only deliberate, public error messages may reach the API or call history. */
export class ModelSettingsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ModelSettingsError';
    this.status = status;
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === 'localhost.' || host === '::1'
    || (isIP(host) === 4 && host.startsWith('127.'));
}

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    const text = value.trim();
    if (!text || /[\s\\?#]/.test(text)) throw new Error();
    url = new URL(text);
    if (url.username || url.password || url.search || url.hash) throw new Error();
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) throw new Error();
  } catch {
    throw new ModelSettingsError(400, '网关地址无效：请使用 HTTPS；HTTP 仅限本机，地址不能包含凭证、查询或片段。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') || '/v1';
  return url.toString().replace(/\/$/, '');
}

function safeModel(value: string): string {
  const model = value.trim();
  if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/.test(value) || /\s/.test(model)) {
    throw new ModelSettingsError(400, '模型名称无效。');
  }
  return model;
}

function safeKey(value: string): string {
  const key = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(value) || /\s/.test(key) || key.length > 8192) {
    throw new ModelSettingsError(400, 'API Key 格式无效。');
  }
  return key;
}

function settingsPath(): string {
  return join(process.cwd(), 'data', 'private', 'model-settings.json');
}

export function validateSettingsInput(value: unknown): ModelSettingsInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelSettingsError(400, '设置内容必须是 JSON 对象。');
  }
  const record = value as Record<string, unknown>;
  const input: ModelSettingsInput = {};
  for (const field of ['baseUrl', 'apiKey', 'model'] as const) {
    if (record[field] === undefined) continue;
    if (typeof record[field] !== 'string') throw new ModelSettingsError(400, '设置字段必须是文字。');
    input[field] = record[field];
  }
  return input;
}

/** Read on each call so saves apply across route bundles, hot reloads and restarts. */
export function getModelSettings(): ModelSettings {
  let saved: ModelSettingsInput = {};
  try {
    saved = validateSettingsInput(JSON.parse(readFileSync(settingsPath(), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new ModelSettingsError(500, '无法读取本机模型设置，请检查本机设置文件。');
    }
  }
  const environmentModels = (process.env.LLM_MODELS ?? DEFAULT_MODELS).split(',').map((model) => model.trim()).filter(Boolean).map(safeModel);
  const model = safeModel(saved.model ?? environmentModels[0] ?? DEFAULT_MODELS.split(',')[0]);
  const models = [...new Set(saved.model ? [model, ...environmentModels] : environmentModels.length ? environmentModels : [model])];
  const settings = {
    baseUrl: normalizeBaseUrl(saved.baseUrl ?? process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL),
    apiKey: safeKey(saved.apiKey || process.env.OPENAI_NEXT_API_KEY || ''),
    model,
    models,
  };
  assertPublicFieldsContainNoKey(settings);
  return settings;
}

export function resolveModelSettings(input: ModelSettingsInput): ModelSettings {
  const current = getModelSettings();
  const model = input.model === undefined ? current.model : safeModel(input.model);
  const settings = {
    baseUrl: input.baseUrl === undefined ? current.baseUrl : normalizeBaseUrl(input.baseUrl),
    apiKey: input.apiKey === undefined || !input.apiKey.trim() ? current.apiKey : safeKey(input.apiKey),
    model,
    models: [...new Set([model, ...current.models])],
  };
  assertPublicFieldsContainNoKey(settings);
  return settings;
}

function assertPublicFieldsContainNoKey(settings: ModelSettings) {
  if (settings.apiKey && [settings.baseUrl, ...settings.models].some((value) => value.includes(settings.apiKey))) {
    throw new ModelSettingsError(400, '网关地址和模型名称不能包含 API Key。');
  }
}

export function publicModelSettings(settings: ModelSettings) {
  return { baseUrl: settings.baseUrl, model: settings.model, configured: Boolean(settings.apiKey) };
}

export function saveModelSettings(input: ModelSettingsInput) {
  const settings = resolveModelSettings(input);
  requireApiKey(settings);
  const path = settingsPath();
  const directory = join(process.cwd(), 'data', 'private');
  const temporaryPath = join(directory, `.model-settings-${randomUUID()}.tmp`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, JSON.stringify({
      baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
    }, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, path);
  } catch {
    throw new ModelSettingsError(500, '无法保存本机模型设置，请检查目录写入权限。');
  } finally {
    try { rmSync(temporaryPath, { force: true }); } catch { /* Never expose filesystem errors. */ }
  }
  return publicModelSettings(settings);
}

function requireApiKey(settings: ModelSettings) {
  if (!settings.apiKey) throw new ModelSettingsError(400, '尚未配置 API Key，请先填写密钥。');
}

export function publicModelError(error: unknown): ModelSettingsError {
  return error instanceof ModelSettingsError ? error : new ModelSettingsError(502, '无法连接模型网关，请检查地址和网络。');
}

/** No retry and no redirect: one user action creates at most one gateway request. */
export async function fetchModelGateway(settings: ModelSettings, endpoint: 'models' | 'chat/completions', options: RequestInit = {}, timeoutMs = 15_000): Promise<unknown> {
  requireApiKey(settings);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${settings.baseUrl}/${endpoint}`, {
      ...options,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
    if (!response.ok) {
      const status = response.status >= 400 && response.status < 600 ? response.status : 502;
      throw new ModelSettingsError(status, `模型网关返回 HTTP ${response.status}，请检查密钥、模型和网关状态。`);
    }
    try {
      return await response.json();
    } catch {
      if (controller.signal.aborted) throw new ModelSettingsError(504, '模型网关响应超时，请稍后重试。');
      throw new ModelSettingsError(502, '模型网关返回了无法识别的响应。');
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (controller.signal.aborted) throw new ModelSettingsError(504, '模型网关响应超时，请稍后重试。');
    throw publicModelError(error);
  } finally {
    clearTimeout(timer);
  }
}

export async function listGatewayModels(settings: ModelSettings): Promise<string[]> {
  const response = await fetchModelGateway(settings, 'models');
  const rows = Array.isArray(response) ? response : (response as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) throw new ModelSettingsError(502, '模型网关没有返回有效的模型列表。');
  const models = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || row.id.includes(settings.apiKey)) continue;
    try { models.add(safeModel(row.id)); } catch { /* Skip invalid gateway IDs. */ }
  }
  const isGpt = (model: string) => /(?:^|[/._-])gpt(?:$|[/._\d-])/i.test(model);
  return [...models].sort((a, b) => Number(isGpt(b)) - Number(isGpt(a)) || a.localeCompare(b));
}

export async function testGatewayModel(settings: ModelSettings) {
  const response = await fetchModelGateway(settings, 'chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: 'Reply only OK.' }], max_tokens: 16 }),
  }) as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new ModelSettingsError(502, '模型网关没有返回有效的测试回复。');
  // A gateway can echo credentials even in a successful reply; expose only status.
  return { ok: true, model: settings.model, message: '连接成功，已收到模型测试回复。' };
}
