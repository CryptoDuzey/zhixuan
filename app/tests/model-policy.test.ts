import test from 'node:test';
import assert from 'node:assert/strict';
import { factualModelOptions } from '../lib/model-policy.ts';
test('证据任务的能力路由不跨服务商，保留已配置回退且不改凭证', () => {
  assert.deepEqual(factualModelOptions({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', models: ['deepseek-flash'] }),
    { models: ['deepseek-v4-pro', 'deepseek-flash'], reasoning: 'low' });
  assert.deepEqual(factualModelOptions({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', models: ['deepseek-v4-pro'] }), { reasoning: 'low' });
  assert.deepEqual(factualModelOptions({ baseUrl: 'https://custom.example/v1', model: 'deepseek-flash', models: ['deepseek-flash'] }), {});
  assert.deepEqual(factualModelOptions({ baseUrl: 'https://api.deepseek.com/v1', model: 'custom-model', models: ['custom-model'] }), {});
});
