import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSession } from '../lib/agent.ts';
import { SessionRepository } from '../lib/session-store.ts';
import { toView } from '../lib/store.ts';

test('图片版本随会话落盘，重新打开仓库后页面仍请求原版本', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zhixuan-image-version-'));
  try {
    const repository = new SessionRepository(directory, newSession);
    const session = repository.get('versioned-session').session;
    const sha256 = '1'.repeat(64);
    session.images = [{ id: 'IMG1', docId: 'image/with spaces', modelId: 'd14', modelName: 'D14',
      filename: 'picture.jpg', caption: '本稿配图', purpose: '外观', width: 800, height: 600,
      source: '本地已下载知识库', url: '', sha256 }];
    repository.save('versioned-session');
    const reopened = new SessionRepository(directory, newSession);
    const restored = reopened.get('versioned-session').session;
    assert.equal(restored.images?.[0].sha256, sha256);
    const image = new URL(toView(restored).images[0].src, 'http://localhost');
    assert.equal(image.pathname, '/api/image');
    assert.equal(image.searchParams.get('id'), 'image/with spaces');
    assert.equal(image.searchParams.get('version'), sha256);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('旧会话没有图片版本时不伪造版本或破坏旧链接', () => {
  const session = newSession();
  session.images = [{ id: 'IMG1', docId: 'legacy-image', modelId: 'd14', modelName: 'D14',
    filename: 'picture.jpg', caption: '旧配图', purpose: '外观', width: 800, height: 600,
    source: '本地已下载知识库', url: '' }];
  const image = new URL(toView(session).images[0].src, 'http://localhost');
  assert.equal(image.searchParams.get('id'), 'legacy-image');
  assert.equal(image.searchParams.has('version'), false);
});
