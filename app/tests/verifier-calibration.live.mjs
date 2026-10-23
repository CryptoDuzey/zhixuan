// Fixed, labelled replay of observed failures. Run baseline before editing the verifier.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyEvidence } from '../lib/agent.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { consumeCompletion } from '../lib/model-stream.ts';
import { getModelSettings } from '../lib/model-settings.ts';
const label = process.argv[2];
if (!/^(baseline|candidate)$/.test(label)) throw new Error('Use baseline or candidate');
const folder = process.env.VERIFIER_EVAL_DIR || '../output/iterations/verifier-calibration-20261021';
const repeats = Number(process.env.VERIFIER_EVAL_REPEATS || 2);
if (![2, 3].includes(repeats)) throw new Error('Repeats must be 2 or 3');
mkdirSync(folder, { recursive: true });
if ((await import('node:fs')).existsSync(`${folder}/${label}.json`)) throw new Error('Refusing to overwrite previous experiment');
const settings = getModelSettings();
const modelFingerprint = createHash('sha256').update(JSON.stringify({ baseUrl: settings.baseUrl, models: settings.models })).digest('hex');
const capture = new AsyncLocalStorage();
const actualFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await actualFetch(...args);
  const context = capture.getStore();
  if (context && String(args[0]).includes('/chat/completions') && response.ok) {
    context.pending.push(consumeCompletion(response.clone(), new AbortController().signal, () => {}).then(result => {
      context.raw.push(result.text);
    }).catch(error => { context.raw.push(`CAPTURE_ERROR: ${error.message}`); }));
  }
  return response;
};
// Public view omits image-review metadata; replay the saved execution input instead.
const original = JSON.parse(readFileSync('data/private/sessions/final-wechat-travel-1792506250983.json', 'utf8')).session;
const samples = [
  { id: 'safe-half', text: '但重量只回答携带这一半问题。', bad: false, origin: 'wechat-travel 正文第2段；一半为问题维度的比喻，无50%效果主张' },
  { id: 'safe-bluetooth', text: '这台机器列有蓝牙6.0。蓝牙版本存在，不等于你的会议耳机、麦克风或演示器已经适配；外设的具体型号、接口和驱动要求仍需按实际设备确认。', bad: false, origin: 'wechat-travel 无线段落' },
  { id: 'safe-ports', text: '另一个USB-C的具体显示能力及多屏组合仍需核对，而不是默认两个USB-C能同时解决所有连接。', bad: false, origin: 'wechat-travel 会议外设段落' },
  { id: 'safe-action', text: '先列出每天必用的软件及版本，确认厂商对HarmonyOS 6.1的支持情况，再带上会议耳机和扩展坞做一次实际连接。', bad: false, origin: 'wechat-travel 软件段落' },
  { id: 'safe-qualified-weight', text: 'HUAWEI MateBook Pro S标准屏版重量为798 g，不同版本重量不同，实际重量还会受配置、制造工艺和测量方法影响。', bad: false, origin: 'wechat-travel 有条件的重量事实' },
  { id: 'bad-feeling', text: '标准屏版798 g，装包后背一天也没有负担。', bad: true, origin: 'xhs-student 主观负担越界的强化对照' },
  { id: 'bad-compatibility', text: 'HarmonyOS 6.1保证兼容你的所有Windows行业软件和会议外设。', bad: true, origin: 'wechat-travel 兼容边界反向对照' },
  { id: 'bad-version', text: 'HUAWEI MateBook Pro S所有版本均重798 g。', bad: true, origin: 'wechat-travel 多版本重量对照' },
  { id: 'bad-port', text: '左右两个USB-C接口都支持同时外接4K@60 Hz双屏。', bad: true, origin: 'wechat-travel 仅右口明确视频输出能力的反向对照' },
  { id: 'bad-number', text: 'HUAWEI MateBook Pro S标准屏版重量为650 g。', bad: true, origin: 'wechat-travel 错误参数对照' },
];
const cases = samples.map(s => ({ ...s, draft: { ...original.draft, title: '', lead: '', body: s.text, cta: '', tags: [], images: [], claims: [] }, evidence: original.evidence, images: [] }));
// Unmodified long real output guards against isolated-sentence benchmark bias.
cases.push({ id: 'real-wechat', bad: null, origin: 'final-wechat-travel-1792506250983', draft: original.draft, evidence: original.evidence, images: original.images });
const corpusHash = createHash('sha256').update(JSON.stringify(cases)).digest('hex');
if (label === 'candidate') {
  const baseline = JSON.parse(readFileSync(`${folder}/baseline.json`, 'utf8')).summary;
  if (baseline.corpusHash !== corpusHash || baseline.repeats !== repeats
    || baseline.modelFingerprint !== modelFingerprint) throw new Error('Baseline inputs, repetitions or model differ');
}
const realLabels = [
  { id: 'half', needle: '重量只回答携带这一半问题', bad: false },
  { id: 'ports-advice', needle: '而不是默认两个USB-C能同时解决所有连接', bad: false },
  { id: 'bluetooth-caution', needle: '蓝牙版本存在不等于你的会议耳机麦克风或演示器已经适配', bad: false },
  { id: 'purchase-advice', needle: '先别因为798g就下单', bad: false },
  { id: 'subjective-effect', needle: '机身重量会直接影响你愿不愿意每天把它放进包里', bad: true },
];
const normalize = text => text.replace(/[\s\p{P}]/gu, '');
const results = [];
let cursor = 0;
async function worker() {
  while (cursor < cases.length * repeats) {
    const n = cursor++, sample = cases[n % cases.length], repeat = Math.floor(n / cases.length) + 1;
    const start = Date.now();
    const context = { pending: [], raw: [] };
    try {
      const report = await capture.run(context, () => verifyEvidence(sample.draft, sample.evidence, sample.images));
      await Promise.all(context.pending);
      const flagged = report.issues.length > 0;
      const annotations = sample.id === 'real-wechat' ? realLabels.map(item => ({ ...item, flagged: report.issues.some(issue => normalize(issue.text).includes(normalize(item.needle))) })) : undefined;
      const result = { id: sample.id, repeat, expectedBad: sample.bad, flagged, correct: sample.bad === null ? null : flagged === sample.bad, annotations, issues: report.issues, verified: report.verifiedClaimIds, rawOutputs: context.raw, ms: Date.now() - start };
      results.push(result);
      console.log(JSON.stringify({ id: sample.id, repeat, correct: result.correct, issues: report.issues.length }));
    } catch (error) {
      await Promise.all(context.pending);
      results.push({ id: sample.id, repeat, error: String(error), correct: false, rawOutputs: context.raw });
    }
  }
}
await Promise.all([worker(), worker()]);
const scored = results.filter(x => x.expectedBad !== null && !x.error);
const real = results.flatMap(x=>x.annotations ?? []);
const summary = { label, corpusHash, promptHash: createHash('sha256').update(readFileSync('lib/agent.ts')).digest('hex'), modelFingerprint, modelSettings: 'existing local provider; no settings changed', repeats, accuracy: `${scored.filter(x=>x.correct).length}/${scored.length}`, falsePositives: scored.filter(x=>!x.expectedBad && x.flagged).length, missedErrors: scored.filter(x=>x.expectedBad && !x.flagged).length, realFalsePositives: real.filter(x=>!x.bad && x.flagged).length, realMissedErrors: real.filter(x=>x.bad && !x.flagged).length, errors: results.filter(x=>x.error).length };
writeFileSync(`${folder}/${label}.json`, JSON.stringify({ summary, labels: samples.map(({id,text,bad,origin})=>({id,text,bad,origin})), results }, null, 2));
console.log(JSON.stringify(summary));
