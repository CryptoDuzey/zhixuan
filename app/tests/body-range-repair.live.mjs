// Fault injection: observed 140-character draft -> real model length repair.
// First draft and verifier are fixtures: this is NOT a factual-quality or UI test.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { loadCatalog, loadCatalogEvidence } from '../lib/catalog.ts';
import { createConversationSources } from '../lib/agent-conversation.ts';
import { newSession, writeFromNeed } from '../lib/agent.ts';
import { reviewFixture } from './claim-review-fixture.ts';
const out = process.env.RANGE_REPAIR_OUT || '../output/iterations/user-body-range-repair-20261021';
await mkdir(out, { recursive: true });
if (await access(`${out}/results.json`).then(() => true, () => false)) throw new Error('Refusing overwrite');
const body = '通勤路上背着电脑，最怕肩膀先累。HUAWEI MateBook Pro S 标准屏版重798 g，14.2英寸柔性OLED屏幕，HarmonyOS 6.1。机身只有两个USB-C口，通勤常用U盘、HDMI投影的话，得提前准备转接。不同版本配置可能不同，购买前请确认对应的官方规格。';
const message = '先联网搜索 MateBook Pro S 的官网介绍，然后按已有产品资料写一条朋友圈，面向通勤办公的人。正文150—250字，只用2张现有图库图片，不生成新图，不写价格优惠或亲测。';
const catalog = await loadCatalog();
const product = catalog.find(item => item.name === 'HUAWEI MateBook Pro S');
if (!product) throw new Error('Missing actual product');
const sources = createConversationSources([product]);
const images = (await sources.loadImages(product.id)).filter(image => image.visuallyReviewed).slice(0, 2);
const facts = await loadCatalogEvidence(product.id);
const fact = facts.find(item => /798/.test(item.text));
if (images.length !== 2 || !fact || [...body].length !== 140) throw new Error('Fixture does not match');
const initial = { title: '', lead: '', body, cta: '', tags: [], images: images.map(image => ({ imageId: image.id, position: '正文后', caption: image.caption })), claims: [{ id: 'C1', text: '标准屏版重798 g', factIds: [fact.id] }] };
const realFetch = globalThis.fetch;
const results = { label: '长度补救故障注入；首稿和事实审核使用替身，仅篇幅修正调用真实模型；不计入真实网页或事实正确率', sourceFailure: 'user-hybrid-final-20261021 R2, two identical 140-character previews', originalLength: 140, bounds: [150, 250], results: [] };
for (let repeat = 1; repeat <= 3; repeat++) {
  let attempts = 0, realCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/chat/completions')) return realFetch(input, init);
    attempts++;
    const wire = data => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] });
    if (attempts === 1) return wire(initial);
    if (attempts === 2) { realCalls++; return realFetch(input, init); }
    const request = JSON.parse(String(init.body));
    return wire(reviewFixture(request.messages.map(message => message.content).join('\n')));
  };
  const s = newSession(); s.modelId = product.id; s.modelName = product.name;
  const need = { intent: 'create', platform: '朋友圈', scene: '通勤办公', audience: '通勤办公的人', facts_from_user: ['只用2张现有图库图片', '不生成新图', '不写价格优惠或亲测'], unknowns: [], unsupported_requests: [], next_action: 'write' };
  let error;
  try { await writeFromNeed(need, message, s, () => {}, sources); } catch (e) { error = e.message; }
  globalThis.fetch = realFetch;
  const length = s.draft ? [...s.draft.body].length : 0;
  results.results.push({ repeat, realCalls, length, body: s.draft?.body, images: s.draft?.images.length, error, lengthPassed: length >= 150 && length <= 250 && s.draft?.images.length === 2 && realCalls === 1, fixtureCompleted: !error });
  console.log(JSON.stringify(results.results.at(-1)));
  await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
}
if (!results.results.every(result => result.lengthPassed && result.fixtureCompleted)) process.exitCode = 1;
