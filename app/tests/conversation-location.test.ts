import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationId, pinConversation } from '../app/components/conversation-location.ts';

test('two window refreshes retain each own explicit chat after shared recent changes', () => {
  assert.equal(conversationId('?chat=window-a', 'window-b'), 'window-a');
  assert.equal(conversationId('?chat=window-b', 'window-a'), 'window-b');
  assert.equal(conversationId('', 'window-b'), 'window-b');
});
test('invalid or duplicate explicit chat does not open an unrelated recent conversation', () => {
  for (const query of ['?chat=', '?chat=bad!', '?chat=window-a&chat=window-b', '?chat=%2Fprivate']) {
    assert.equal(conversationId(query, 'window-b'), undefined);
  }
});
test('pin replaces prior id, preserves query hash and router state, never navigates', () => {
  const state = { router: 'existing' };
  let received: unknown[] = [];
  const history = { state, replaceState: (...args: unknown[]) => { received = args; } };
  assert.equal(pinConversation('window-a', { pathname: '/consult', search: '?other=value&chat=window-b', hash: '#answer' }, history), true);
  assert.equal(received[0], state);
  assert.equal(received[2], '/consult?other=value&chat=window-a#answer');
});
test('pin works without browser storage; blocked history or invalid id fails visibly to caller', () => {
  let url = '';
  const location = { pathname: '/', search: '', hash: '' };
  assert.equal(pinConversation('window-a', location, { state: null, replaceState: (_a: unknown, _b: string, next?: string | URL | null) => { url = String(next); } }), true);
  assert.equal(url, '/?chat=window-a');
  assert.equal(pinConversation('window-a', location, { state: null, replaceState: () => { throw Error('blocked'); } }), false);
  assert.equal(pinConversation('bad!', location, { state: null, replaceState: () => { throw Error('must not call'); } }), false);
});
