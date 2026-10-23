// One real saved-input diagnostic. Raw text stays in the ignored local output folder.
import { readFileSync, writeFileSync } from 'node:fs';
import { verifyEvidence } from '../lib/agent.ts';
import { parseClaimReview } from '../lib/claim-review.ts';
import { consumeCompletion } from '../lib/model-stream.ts';
import { extractJson } from '../lib/llm.ts';
if (process.env.REPLAY_RETIRED_VERIFIER_CORPUS !== '1') throw new Error('这是已撤回完整协议的历史诊断，不是当前验收。当前请使用claim-coverage-acceptance.live.mjs。');
const input = JSON.parse(readFileSync('data/private/sessions/final-wechat-travel-1792506250983.json', 'utf8')).session;
const actual = globalThis.fetch, pending = [], responses = [];
globalThis.fetch = async (...args) => {
  const response = await actual(...args);
  if (String(args[0]).includes('/chat/completions') && response.ok) {
    pending.push(consumeCompletion(response.clone(), new AbortController().signal, () => {}).then(result => {
      let validation = 'accepted';
      try { parseClaimReview(extractJson(result.text), input.draft.claims, input.evidence); }
      catch (error) { validation = error.message; }
      responses.push({ validation, raw: result.text });
    }));
  }
  return response;
};
let outcome;
try { outcome = await verifyEvidence(input.draft, input.evidence, input.images); }
catch (error) { outcome = { error: error.message }; }
await Promise.all(pending);
writeFileSync('../output/iterations/verifier-coverage-20261021/diagnostic.json', JSON.stringify({ responses, outcome }, null, 2));
console.log(JSON.stringify({ validation: responses.map(row => row.validation), error: outcome.error, issues: outcome.issues?.length }));
