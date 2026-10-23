import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelSettingsError } from './model-settings.ts';
import { runSignal, throwIfStopped, useModelAttempt } from './agent-runtime.ts';

const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const LIMIT = 12 * 1024 * 1024;
export interface SceneImage {
  id: string;
  sha256: string;
  width: number;
  height: number;
  provider: 'qwen';
  providerModel: string;
  createdAt: string;
}
export interface SupplementaryImage extends SceneImage {
  modelId: string;
  draftVersion: number;
  caption: string;
  sceneDescription?: string; // Intended scene, not a verified description of pixels.
}

const folder = () => join(process.cwd(), 'data', 'private', 'scene-images');
const fail = (message = '配图暂时没能完成，原稿和现有图片仍可继续使用。') => new ModelSettingsError(502, message);
function settings() {
  let saved: Record<string, unknown> = {};
  try { saved = JSON.parse(readFileSync(join(process.cwd(), 'data', 'private', 'image-settings.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw fail('配图设置暂时无法读取。'); }
  const apiKey = saved.apiKey || process.env.QWEN_IMAGE_API_KEY;
  const model = saved.model || 'qwen-image-2.0-pro-2026-06-22';
  const endpoint = saved.endpoint || ENDPOINT;
  if (typeof apiKey !== 'string' || !apiKey.trim() || /\s/.test(apiKey) || apiKey.length > 8192) throw fail('配图服务还没接通，现有图库仍可使用。');
  if (typeof model !== 'string' || !/^qwen-image-2\.0(?:-pro)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model)
    || ![ENDPOINT, ENDPOINT.replace('dashscope.', 'dashscope-intl.')].includes(String(endpoint))) throw fail('配图服务设置不正确。');
  return { apiKey, model, endpoint: endpoint as string };
}
function check(signal: AbortSignal) { if (signal.aborted) throw signal.reason; throwIfStopped(); }
async function bytes(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) throw fail();
  const reader = response.body?.getReader();
  if (!reader) throw fail();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      check(signal);
      const part = await reader.read();
      check(signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw fail();
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    try { void reader.cancel().catch(() => {}); } catch { /* Already closed. */ }
    reader.releaseLock();
  }
}
function dimensions(data: Buffer) {
  if (data.length < 33 || !data.subarray(0, 8).equals(PNG) || data.toString('ascii', 12, 16) !== 'IHDR') throw fail();
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 2048 * 2048) throw fail();
  return { width, height };
}

/** Official synchronous API. A timeout never causes an automatic second purchase. */
export async function generateScene(prompt: string, parent = runSignal()): Promise<SceneImage> {
  if (!prompt.trim() || prompt.length > 1500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(prompt)) throw fail('配图描述需要简短、具体一些。');
  const config = settings();
  const signal = AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(150_000)]);
  try {
    check(signal);
    useModelAttempt();
    const response = await fetch(config.endpoint, {
      method: 'POST', signal, redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model,
        input: { messages: [{ role: 'user', content: [{ text: `画一张不含品牌和产品细节的环境插画，不含电脑、手机、平板、显示器、打印机、屏幕、商标、品牌文字、功能演示、参数和数字。只用环境与普通生活物件表达场景，不要宣传语。画面需求：${prompt}` }] }] },
        parameters: { size: '1024*1024', n: 1, prompt_extend: false, watermark: true,
          negative_prompt: '电脑，手机，平板，显示器，打印机，屏幕，电子设备，品牌标识，广告文字，产品参数，界面截图，功能演示' },
      }),
    });
    check(signal);
    if (!response.ok) {
      try { void response.body?.cancel().catch(() => {}); } catch { /* Ignore transport cleanup. */ }
      throw fail([401, 403].includes(response.status) ? '配图服务暂时无法连接，请检查配图密钥或权限。'
        : [402, 429].includes(response.status) ? '配图服务暂时不可用，可能需要稍后再试或补充额度。' : undefined);
    }
    const data = JSON.parse((await bytes(response, 256 * 1024, signal)).toString('utf8'));
    const content = data?.output?.choices?.[0]?.message?.content;
    const raw = Array.isArray(content) ? content.find(item => typeof item?.image === 'string')?.image : undefined;
    const url = new URL(typeof raw === 'string' ? raw : 'invalid');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !/^[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname)) throw fail();
    check(signal);
    // No provider credential is forwarded to image storage or redirects.
    const image = await fetch(url, { signal, redirect: 'error' });
    check(signal);
    if (!image.ok || !/^image\/png(?:;|$)/i.test(image.headers.get('content-type') ?? '')) throw fail();
    const binary = await bytes(image, LIMIT, signal);
    const size = dimensions(binary);
    const asset: SceneImage = { id: randomUUID(), sha256: createHash('sha256').update(binary).digest('hex'),
      ...size, provider: 'qwen', providerModel: config.model, createdAt: new Date().toISOString() };
    check(signal);
    mkdirSync(folder(), { recursive: true });
    writeFileSync(join(folder(), `${asset.id}.png`), binary, { flag: 'wx', mode: 0o600 });
    check(signal);
    return asset;
  } catch (error) {
    if (parent?.aborted) throw parent.reason;
    throwIfStopped();
    if (error instanceof ModelSettingsError) throw error;
    throw fail(signal.aborted ? '等待配图超时，先保留当前稿件，稍后可以再试。' : undefined);
  }
}

/** Only immutable local PNGs with the stored content version can be delivered. */
export function readSceneImage(asset: SceneImage): Buffer {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(asset.id) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw fail('图片记录无法读取。');
  let binary: Buffer;
  try { binary = readFileSync(join(folder(), `${asset.id}.png`)); }
  catch { throw fail('图片暂时无法读取，请重新选择配图。'); }
  if (binary.length > LIMIT || createHash('sha256').update(binary).digest('hex') !== asset.sha256) throw fail('图片文件已变化，请重新选择配图。');
  const size = dimensions(binary);
  if (size.width !== asset.width || size.height !== asset.height) throw fail('图片文件已变化，请重新选择配图。');
  return binary;
}

export function sceneImageUrl(sessionId: string, asset: SceneImage) {
  return `/api/scene-image?sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(asset.id)}&version=${asset.sha256}`;
}
