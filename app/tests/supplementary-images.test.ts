import test from 'node:test';
import assert from 'node:assert/strict';
import { newSession, type Session } from '../lib/agent.ts';
import { supplementImages, currentSceneImages, sceneImagesForRevision } from '../lib/supplementary-images.ts';
import type { ImageRef } from '../lib/facts.ts';
import type { CheckReport, Draft } from '../lib/check.ts';
import { cancelRun, createRun, withRun } from '../lib/agent-runtime.ts';

const image = (id: string): ImageRef => ({ id, modelId: 'pro-s', modelName: 'Pro S', docId: id,
  filename: `${id}.png`, sha256: 'a'.repeat(64), caption: '紫色机身外观', purpose: '产品外观',
  visuallyReviewed: true, width: 800, height: 600, source: '本地已下载知识库', url: '' });
const asset = { id: '12345678-1234-1234-1234-123456789012', sha256: 'b'.repeat(64), width: 1024, height: 1024,
  provider: 'qwen' as const, providerModel: 'qwen-image-2.0-pro-2026-06-22', createdAt: '2026-10-20' };
function session(): Session {
  return { ...newSession(), modelId: 'pro-s', modelName: 'Pro S', images: [image('IMG1')], evidence: [],
    draft: { version: 1, platform: '朋友圈', modelId: 'pro-s', modelName: 'Pro S', title: '出差收拾行李', body: '原稿正文', lead: '', cta: '', tags: [], images: [{ imageId: 'IMG1', position: '正文后', caption: '产品外观' }], claims: [] },
    report: { draftVersion: 1, status: 'pass', issues: [], verifiedClaimIds: [], verifiedImageIds: [], checkedAt: '' },
  };
}
const check = async (draft: Draft): Promise<CheckReport> => ({ draftVersion: draft.version, status: 'pass', issues: [], verifiedClaimIds: [], verifiedImageIds: [], checkedAt: '' });

test('suitable library images are reused without generation and checked as a new version', async () => {
  const s = session();
  let generated = 0;
  await supplementImages('补张外观图', s, true, () => {}, { loadImages: async () => [image('IMG1'), image('IMG2')],
    plan: async () => ({ action: 'reuse', imageId: 'IMG2' }), check,
    generate: async () => { generated++; return asset; } });
  assert.equal(generated, 0);
  assert.equal(s.draft!.version, 2);
  assert.equal(s.report!.draftVersion, 2);
  assert.deepEqual(s.draft!.images.map(item => item.imageId), ['IMG1', 'IMG2']);
  assert.deepEqual(currentSceneImages(s), []);
});
test('a suitable image already in the draft does not duplicate it or call generation/check', async () => {
  const s = session();
  const original = structuredClone(s);
  await supplementImages('这张就行', s, true, () => {}, { loadImages: async () => [image('IMG1')],
    plan: async () => ({ action: 'reuse', imageId: 'IMG1' }),
    check: async () => { assert.fail('no changed draft'); }, generate: async () => { assert.fail('library is sufficient'); } });
  assert.deepEqual(s, original);
});
test('a library outage or an explicit no-generation instruction never purchases a generated image', async () => {
  for (const outage of [true, false]) {
    const s = session(), original = structuredClone(s);
    const result = supplementImages('只用图库', s, false, () => {}, {
      loadImages: async () => { if (outage) throw new Error('library unavailable'); return []; },
      plan: async () => ({ action: 'generate', scenePrompt: '行李插画' }), check,
      generate: async () => { assert.fail('must not call provider'); },
    });
    if (outage) await assert.rejects(result, /library unavailable/); else await result;
    assert.deepEqual(s, original);
  }
});
test('generated scenes stay separate from official photos and disappear from a later draft version', async () => {
  const s = session();
  await supplementImages('补行李环境图', s, true, () => {}, { loadImages: async () => [image('IMG1')],
    plan: async () => ({ action: 'generate', scenePrompt: '行李环境插画' }), generate: async () => asset, check });
  assert.equal(s.draft!.version, 2);
  assert.equal(s.report!.draftVersion, 2);
  assert.equal(s.draft!.images.length, 1, 'generated scenes never fill official product-photo requirements');
  assert.equal(currentSceneImages(s).length, 1);
  assert.match(currentSceneImages(s)[0].caption, /AI 生成/);
  s.draft!.version++;
  assert.equal(currentSceneImages(s).length, 0, 'editing text does not silently reuse a scene for another version');
});
test('failed checks preserve the complete old draft, sources and scene snapshot', async () => {
  const s = session(), original = structuredClone(s);
  await assert.rejects(supplementImages('补环境图', s, true, () => {}, {
    loadImages: async () => [image('IMG1')], plan: async () => ({ action: 'generate', scenePrompt: '环境图' }),
    generate: async () => asset, check: async () => { throw new Error('check failed'); },
  }), /check failed/);
  assert.deepEqual(s, original);
});
test('removing generated scenes keeps original text/photos, does not generate and rechecks the new version', async () => {
  const s = session();
  s.supplementaryImages = [{ ...asset, modelId: 'pro-s', draftVersion: 1, caption: 'AI 生成场景图' }];
  const original = structuredClone(s.draft!);
  await supplementImages('移除AI图', s, { allowGeneration: false, removeGenerated: true }, () => {}, {
    loadImages: async () => [image('IMG1')], check,
    plan: async () => { assert.fail('removal needs no image selection'); },
    generate: async () => { assert.fail('removal must not purchase images'); },
  });
  assert.equal(s.draft!.version, 2);
  assert.equal(s.draft!.body, original.body);
  assert.deepEqual(s.draft!.images, original.images);
  assert.equal(s.report!.draftVersion, 2);
  assert.deepEqual(currentSceneImages(s), []);
});
test('wording edits rebind only selected same-product scene bytes to the new draft version', async () => {
  const s = session();
  s.supplementaryImages = [{ ...asset, modelId: 'pro-s', draftVersion: 1, caption: 'AI 生成场景图' }];
  const next = { ...structuredClone(s.draft!), body: '更口语的出差收拾行李建议', version: 2 };
  const kept = await sceneImagesForRevision(s, next, '只改口语', async input => {
    assert.equal(input.previous.version, 1);
    assert.equal(input.next.version, 2);
    return [asset.id, asset.id, 'unknown-id'];
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].draftVersion, 2);
  assert.equal(kept[0].sha256, asset.sha256);
  assert.equal(s.supplementaryImages[0].draftVersion, 1, 'decision alone never partially mutates the old draft');
});
test('different products, changed scenes and platform image capacity do not silently carry old assets', async () => {
  const s = session();
  s.supplementaryImages = [{ ...asset, modelId: 'pro-s', draftVersion: 1, caption: 'AI 生成场景图' }];
  const next = { ...structuredClone(s.draft!), version: 2 };
  assert.deepEqual(await sceneImagesForRevision(s, { ...next, modelId: 'd14' }, '换产品', async () => { assert.fail('cross-product images cannot be considered'); }), []);
  assert.deepEqual(await sceneImagesForRevision(s, next, '改为固定书桌办公', async () => []), []);
  const full = { ...next, images: Array.from({ length: 3 }, (_, i) => ({ imageId: `IMG${i}`, position: '正文后', caption: '' })) };
  assert.deepEqual(await sceneImagesForRevision(s, full, '保留三张产品图', async () => { assert.fail('no image slots remain'); }), []);
});
test('stopping while generation is pending prevents a late response from changing the saved draft', async () => {
  const s = session(), original = structuredClone(s), run = createRun();
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const result = withRun('scene-cancel-test', run, () => {}, () => supplementImages('补环境图', s, true, () => {}, {
    loadImages: async () => [image('IMG1')], plan: async () => ({ action: 'generate', scenePrompt: '环境图' }), check,
    generate: () => new Promise(resolve => { release = () => resolve(asset); started(); }),
  }));
  await ready;
  assert.equal(cancelRun('scene-cancel-test', run.id), true);
  await assert.rejects(result);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(s, original);
});
