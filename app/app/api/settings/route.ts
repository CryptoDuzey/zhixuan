import {
  getModelSettings, isLoopbackHost, listGatewayModels, ModelSettingsError,
  publicModelError, publicModelSettings, resolveModelSettings, saveModelSettings,
  testGatewayModel, validateSettingsInput,
} from '../../../lib/model-settings.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function assertLocalRequest(request: Request, modifying = false) {
  const url = new URL(request.url);
  const host = request.headers.get('host') ?? url.host;
  // Do not trust forwarded host headers or a Host header with embedded URL parts.
  if (/[\\/@?#\s]/.test(host)) throw new ModelSettingsError(403, '模型设置仅允许从本机访问。');
  let hostUrl: URL;
  try { hostUrl = new URL(`${url.protocol}//${host}`); }
  catch { throw new ModelSettingsError(403, '模型设置仅允许从本机访问。'); }
  if (!isLoopbackHost(url.hostname) || !isLoopbackHost(hostUrl.hostname) || hostUrl.host !== url.host) {
    throw new ModelSettingsError(403, '模型设置仅允许从本机访问。');
  }
  if (modifying) {
    const origin = request.headers.get('origin');
    if ((origin !== null && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
      throw new ModelSettingsError(403, '不能从其他网站修改本机模型设置。');
    }
  }
}

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    return reply(publicModelSettings(getModelSettings()));
  } catch (error) {
    const safe = publicModelError(error);
    return reply({ ok: false, status: safe.status, message: safe.message }, safe.status);
  }
}

export async function POST(request: Request) {
  let action: unknown;
  let model: string | undefined;
  try {
    assertLocalRequest(request, true);
    let body: unknown;
    try { body = await request.json(); }
    catch { throw new ModelSettingsError(400, '请求内容不是有效的 JSON。'); }
    const input = validateSettingsInput(body);
    action = (body as Record<string, unknown>).action;
    if (!['models', 'test', 'save'].includes(action as string)) throw new ModelSettingsError(400, '不支持的设置操作。');
    if (action === 'save') return reply({ ok: true, ...saveModelSettings(input) });
    const settings = resolveModelSettings(input);
    model = settings.model;
    if (action === 'models') return reply({ models: await listGatewayModels(settings) });
    return reply(await testGatewayModel(settings));
  } catch (error) {
    const safe = publicModelError(error);
    return reply({
      ok: false, status: safe.status, ...(action === 'test' && model ? { model } : {}), message: safe.message,
    }, safe.status);
  }
}
