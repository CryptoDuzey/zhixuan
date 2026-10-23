import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'zx-scene-routes-'));
process.env.ZHIXUAN_SESSION_DIR = join(directory, 'sessions');
const { GET } = await import('../app/api/scene-image/route.ts');
const { GET: exportDraft } = await import('../app/api/export/route.ts');
const { sessionRepository, toView } = await import('../lib/store.ts');
after(() => rmSync(directory, { recursive: true, force: true }));

test('scene delivery binds the session, draft version and actual saved file hash', async t => {
  t.mock.method(process, 'cwd', () => directory);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64');
  const asset = { id: '12345678-1234-1234-1234-123456789012', sha256: createHash('sha256').update(png).digest('hex'),
    width: 1, height: 1, provider: 'qwen' as const, providerModel: 'qwen-image-2.0-pro-2026-06-22', createdAt: '',
    draftVersion: 1, modelId: 'pro-s', caption: 'AI 生成场景图' };
  const record = sessionRepository.get('scene-session');
  record.session = { modelId: 'pro-s', modelName: 'Pro S', supplementaryImages: [asset],
    draft: { version: 1, modelId: 'pro-s', modelName: 'Pro S', platform: '朋友圈', title: '标题', body: '正文', lead: '', cta: '', tags: [], images: [], claims: [] },
    report: { draftVersion: 1, status: 'pass', issues: [], verifiedClaimIds: [], verifiedImageIds: [], checkedAt: '' } };
  sessionRepository.save('scene-session');
  mkdirSync(join(directory, 'data/private/scene-images'), { recursive: true });
  const file = join(directory, 'data/private/scene-images', `${asset.id}.png`);
  writeFileSync(file, png);
  const src = toView(record.session, 'scene-session').supplementaryImages![0].src;
  const request = new Request(`http://localhost${src}`);
  const response = GET(request);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(GET(new Request(request.url.replace('scene-session', 'other-session'))).status, 404);
  assert.equal(GET(new Request(request.url.replace(asset.sha256, 'a'.repeat(64)))).status, 409);
  const exported = await (await exportDraft(new Request('http://localhost/api/export?sessionId=scene-session'))).json();
  assert.equal(exported.supplementaryImages[0].sha256, asset.sha256);
  assert.match(exported.supplementaryImages[0].source, /AI 生成/);
  assert.deepEqual(exported.images, [], 'AI scenes are not exported as official product photos');
  writeFileSync(file, Buffer.concat([png, Buffer.from('tampered')]));
  assert.equal(GET(request).status, 502);
  assert.equal((await exportDraft(new Request('http://localhost/api/export?sessionId=scene-session'))).status, 409);
  record.session.draft!.version = 2;
  record.session.report!.draftVersion = 2;
  sessionRepository.save('scene-session');
  assert.equal(GET(request).status, 404);
  assert.equal(toView(record.session, 'scene-session').supplementaryImages, undefined);
});
