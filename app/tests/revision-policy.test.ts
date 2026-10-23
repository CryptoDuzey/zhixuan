import test from 'node:test';
import assert from 'node:assert/strict';
import { requestsGalleryChange } from '../lib/revision-policy.ts';
test('文字改稿及图库偏好保留原方案，明确调整图片或图注才允许变化', () => {
  for (const text of ['正文缩到120字以内，只用现有图库，不生成图', '更口语一点，不要动配图', '别修改图注，只改开头', '不要换图', '修改图表内容']) assert.equal(requestsGalleryChange(text), false, text);
  for (const text of ['换一张产品图', '纠正图片的图注', '修改图注', '把配图换成另一张', '删除配图', '换图']) assert.equal(requestsGalleryChange(text), true, text);
});
