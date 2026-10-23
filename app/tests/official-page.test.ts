import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOfficialPage, type OfficialPageResult } from '../lib/official-page.ts';
import { createRun, cancelRun, withRun, RunStoppedError } from '../lib/agent-runtime.ts';

const URL = 'https://consumer.huawei.com/cn/harmonyos-computer/matebook-pro-s/';
const NOTE = '价格仅供参考，具体价格请以华为商城展示为准';
const price = (amount = '7999', attrs = '') => `<div class="product-buy-btn-price" ${attrs}>¥ ${amount}<a href="https://www.vmall.com/">立即购买</a></div>`;
const note = (s = NOTE) => `<li class="price_note">${s}</li>`;
const page = (s: string, head = '') => `<!doctype html><html><head><title>HUAWEI MateBook Pro S &amp; 官方介绍</title>${head}</head><body>${s}</body></html>`;
const response = (s: string) => new Response(s, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const read = (s: string) => readOfficialPage(URL, { fetch: async () => response(page(s)) });

test('读取一页静态正文、提取title和严格成对的参考价，单次请求无cookie无凭证', async () => {
  let calls = 0;
  const result: OfficialPageResult = await readOfficialPage(URL, { fetch: async (url, init) => {
    calls++;
    assert.equal(String(url), URL);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('cookie'), false);
    assert.equal(headers.has('authorization'), false);
    return response(page('<h1>超轻超能干</h1><p>官方正文 <b>介绍</b></p>' + price() + note()));
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'ready');
  assert.equal(result.url, URL);
  assert.equal(result.title, 'HUAWEI MateBook Pro S & 官方介绍');
  assert.match(result.text, /官方正文 介绍/);
  assert.equal(result.referencePrice?.amount, 7999);
  assert.equal(result.referencePrice?.currency, 'CNY');
  assert.equal(result.referencePrice?.kind, 'page-reference');
  assert.equal(result.referencePrice?.isTransactionPrice, false);
  assert.equal(result.referencePrice?.hidden, false);
  assert.equal(result.referencePrice?.sourceUrl, URL);
  assert.equal(result.referencePrice?.note, NOTE);
  assert.match(result.text, /不是所选配置.*成交价/);
  assert.ok(Number.isFinite(Date.parse(result.readAt)));
});

test('global-style-hide祖先内的参考价单独标注，不冒充可见商城成交价', async () => {
  const r = await read('<h1>可见介绍</h1><section class="global-style-hide">隐藏推广文字' + price() + note() + '</section>');
  assert.equal(r.status, 'ready');
  assert.equal(r.referencePrice?.hidden, true);
  assert.match(r.text, /HTML中为隐藏内容/);
  assert.match(r.text, /价格仅供参考/);
  assert.doesNotMatch(r.text, /隐藏推广文字/);
});

test('真实官网HTML回归：星号anchor、说明内空格、实体与零宽字符不丢失参考价', async () => {
  // Exact relevant markup observed in the 2026-10-21 official Pro S HTML response.
  const r = await read(`<div class="global-style-hide">
    <div class="product-buy-btn-price">¥ 7999<a href="javascript:;" class="price_btn">*</a>
      <span>起</span>
    </div>
    </div><p>产品介绍</p>
    <li class="price_note footlast1 global-style-hide">价格仅供参考，具体 价格请以华为商城展示为&#8288;⁠准。</li>`);
  assert.equal(r.status, 'ready');
  assert.equal(r.referencePrice?.amount, 7999);
  assert.equal(r.referencePrice?.hidden, true);
  assert.equal(r.referencePrice?.isTransactionPrice, false);
  assert.equal(r.referencePrice?.display, '¥ 7999 起');
  assert.match(r.referencePrice!.note, /商城展示为准/);
  assert.match(r.text, /HTML中为隐藏内容/);
  assert.match(r.text, /不是所选配置.*成交价/);
});

test('hidden、aria-hidden、inline style隐藏正文不输出，价格保留隐藏界限', async () => {
  for (const attr of ['hidden', 'aria-hidden="true"', 'style="display: none !important"', "style='visibility:hidden'"]) {
    const r = await read(`<div ${attr}>不应显示的普通隐藏文字${price()}</div><p>正文</p>${note()}`);
    assert.equal(r.referencePrice?.hidden, true, attr);
    assert.doesNotMatch(r.text, /不应显示的普通隐藏文字/);
  }
});

test('脚本style注释template中的价格和恶意HTML不成为报价或正文', async () => {
  const forged = price('1') + note();
  const r = await readOfficialPage(URL, { fetch: async () => response(page(
    `<h1>真实产品介绍</h1><script>var price=999;var x='${forged}';</script><style>${forged}</style><!--${forged}--><template>${forged}</template><noscript>${forged}</noscript>`
    + '<script type="application/ld+json">{"offers":{"price":2999,"priceCurrency":"CNY"}}</script>',
    `<script>${forged}</script>`)) });
  assert.equal(r.status, 'ready');
  assert.equal(r.text, '真实产品介绍');
  assert.equal(r.referencePrice, undefined);
});

test('普通price、缺说明、说明不完整、只在注释中的说明不生成referencePrice', async () => {
  for (const body of [
    '<div class="price">¥ 7999</div>' + note(), price(), price() + note('参考价格，详情咨询'),
    price() + `<!--${note()}-->`, `<script>${price()}</script>${note()}`,
    `<div class="product-buy-btn-price-fake">¥ 7999</div>${note()}`,
    price() + '<div class="price_note">价格仅供参考，具体价格请以华为商城展示为准</div>',
  ]) {
    const r = await read('<p>介绍</p>' + body);
    assert.equal(r.referencePrice, undefined, body);
  }
});

test('不同参考金额、区间、非数字、未闭合区域均不形成唯一报价', async () => {
  for (const body of [price() + price('8999'), price('7999-8999'), price('unknown'),
    '<div class="product-buy-btn-price">¥ 7999']) {
    const r = await read('<p>介绍</p>' + body + note());
    assert.equal(r.referencePrice, undefined, body);
  }
});

test('重复同价可接受，保留起价限定、HTML实体、千分位和小数', async () => {
  const r = await read('<div class="product-buy-btn-price">&yen;&nbsp;7,999.50 起<a>买</a></div>' + note());
  assert.equal(r.referencePrice?.amount, 7999.5);
  assert.match(r.referencePrice!.display, /起/);
  const duplicate = await read(price() + price() + note());
  assert.equal(duplicate.referencePrice?.amount, 7999);
});

test('文本不超过12000 UTF16单位，参考价和界限不被长正文挤掉，不切断代理对', async () => {
  const r = await read('<p>' + '😀详细介绍'.repeat(8000) + '</p>' + price() + note());
  assert.ok(r.text.length <= 12000);
  assert.doesNotMatch(r.text, /[\ud800-\udbff]$/);
  assert.match(r.text.slice(0, 300), /网页参考价/);
  assert.equal(r.referencePrice?.amount, 7999);
});

test('HTML引号中含大于号不会破坏正文结构，title之外head内容不进入正文', async () => {
  const r = await readOfficialPage(URL, { fetch: async () => response(page('<p data-test="a > b">A &lt; B &amp; 正文</p>', '<meta name="description" content="不是正文"><div>head内容</div>')) });
  assert.equal(r.text, 'A < B & 正文');
  assert.doesNotMatch(r.text, /head内容|不是正文/);
});

test('固定允许已见到的consumer、www.vmall和item.vmall产品路径', async () => {
  for (const url of [URL, URL.replace('https:', 'https:').replace('.com/', '.com:443/'), URL + 'specs/',
    'https://www.vmall.com/product/10086380895025.html',
    'https://www.vmall.com/product/comdetail/index.html?prdId=10086380895025',
    'https://www.vmall.com/product/comdetail/index.html?prdId=10086380895025&cid=388094',
    'https://item.vmall.com/product/comdetail/index.html?prdId=10086380895025&cid=388094']) {
    let calls = 0;
    const r = await readOfficialPage(url, { fetch: async () => { calls++; return response(page('<p>介绍</p>')); } });
    assert.equal(calls, 1, url); assert.equal(r.status, 'ready', url);
  }
});

test('非allowlist、凭证、本机私网、协议和异常authority均拒绝且不发请求', async () => {
  const urls = [
    'http://consumer.huawei.com/cn/harmonyos-computer/matebook-pro-s/',
    'https://consumer.huawei.com:444/cn/harmonyos-computer/matebook-pro-s/',
    'https://consumer.huawei.com.evil.com/cn/harmonyos-computer/matebook-pro-s/',
    'https://consumer.huawei.com@evil.com/', 'https://evil.com@consumer.huawei.com/cn/harmonyos-computer/matebook-pro-s/',
    'https://user:password@consumer.huawei.com/cn/harmonyos-computer/matebook-pro-s/',
    'https://@consumer.huawei.com/cn/harmonyos-computer/matebook-pro-s/',
    'https://consumer.huawei.com./cn/harmonyos-computer/matebook-pro-s/',
    '//consumer.huawei.com/cn/harmonyos-computer/matebook-pro-s/',
    'https://localhost/','https://127.0.0.1/','https://10.0.0.1/','https://169.254.169.254/','https://[::1]/',
    'https://[::ffff:127.0.0.1]/','file:///secret','javascript:alert(1)', 'data:text/html,price',
    URL + '#price', URL + '#', URL + '\n', URL.replace('huawei.com/', 'huawei.com\\'),
    URL.replace('huawei.com', '%63onsumer.huawei.com'), URL.replace('consumer.', '%63onsumer.'),
  ];
  for (const url of urls) {
    let calls = 0;
    const r = await readOfficialPage(url, { fetch: async () => { calls++; throw new Error('must not fetch'); } });
    assert.equal(calls, 0, url); assert.equal(r.status, 'unavailable', url);
    assert.equal(r.url, '', 'Do not reflect credentials or attacker URLs');
  }
});

test('禁止任意路径、路径穿越、编码绕过、任意query及重复参数', async () => {
  for (const url of ['https://consumer.huawei.com/', 'https://consumer.huawei.com/cn/support/download/',
    URL + '?redirect=https://evil.com/', URL.replace('matebook-pro-s/', '../matebook-pro-s/'),
    URL.replace('matebook-pro-s/', '%2e%2e/matebook-pro-s/'),
    'https://www.vmall.com/api/user', 'https://www.vmall.com/product/10086380895025.html?foo=1',
    'https://item.vmall.com/product/comdetail/index.html?prdId=abc',
    'https://item.vmall.com/product/comdetail/index.html?prdId=10086380895025&cid=evil',
    'https://www.vmall.com/product/comdetail/index.html?prdId=10086380895025&redirect=https://evil.com/',
    'https://item.vmall.com/product/comdetail/index.html?prdId=10086380895025&prdId=10086380895026',
    'https://item.vmall.com/product/comdetail/index.html?prdId=10086380895025&cid=1&cid=2']) {
    let calls = 0;
    const r = await readOfficialPage(url, { fetch: async () => { calls++; return response(page('<p>介绍</p>')); } });
    assert.equal(calls, 0, url); assert.equal(r.status, 'unavailable', url);
  }
});

test('请求失败诚实unavailable，不将异常、cookie、密钥或内部错误回显', async () => {
  const r = await readOfficialPage(URL, { fetch: async () => { throw new Error('private-secret-fetchfailed'); } });
  assert.equal(r.status, 'unavailable');
  assert.equal(r.url, URL); assert.equal(r.title, ''); assert.equal(r.text, '');
  assert.equal(r.referencePrice, undefined);
  assert.doesNotMatch(JSON.stringify(r), /private-secret/);
});

test('重定向、错误状态、错误MIME和伪造最终URL均拒绝，只请求一次', async () => {
  for (const make of [
    () => new Response('', {status:302,headers:{location:'https://evil.com/'}}),
    () => new Response('', {status:429}), () => new Response('{"price":7999}', {headers:{'content-type':'application/json'}}),
    () => { const r = response(page('<p>介绍</p>')); Object.defineProperty(r,'redirected',{value:true}); return r; },
    () => { const r = response(page('<p>介绍</p>')); Object.defineProperty(r,'url',{value:'https://evil.com/'}); return r; },
  ]) {
    let calls = 0;
    const r = await readOfficialPage(URL, { fetch: async (_url, init) => { calls++; assert.equal(init?.redirect,'error');return make(); } });
    assert.equal(r.status,'unavailable'); assert.equal(calls,1);
  }
});

test('按原始字节限制1MiB，拒绝超大Content-Length并取消流', async () => {
  let cancelled = false;
  const r = await readOfficialPage(URL,{fetch:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),
    {headers:{'content-type':'text/html','content-length':String(1024*1024+1)}})});
  assert.equal(r.status,'unavailable'); assert.equal(cancelled,true);
});

test('流式实际字节超限即停止，UTF8多字节不按字符串长度放行', async () => {
  let cancelled = false;
  const r = await readOfficialPage(URL,{fetch:async()=>new Response(new ReadableStream({
    start(c){c.enqueue(new TextEncoder().encode('<p>'+'中'.repeat(400000)+'</p>'));},cancel(){cancelled=true;}
  }),{headers:{'content-type':'text/html'}})});
  assert.equal(r.status,'unavailable');assert.equal(cancelled,true);
});

test('恰好1MiB可读取，UTF8无效字节和空页面拒绝',async()=>{
  const exact='<p>正文</p>';
  const size=Buffer.byteLength(exact);
  const ok=await readOfficialPage(URL,{fetch:async()=>response(exact+' '.repeat(1024*1024-size))});
  assert.equal(ok.status,'ready');assert.equal(ok.text,'正文');
  for(const body of [new Uint8Array([0xff,0xfe,0xff]),new Uint8Array(),new TextEncoder().encode('<html><script>price=7999</script></html>')]){
    const r=await readOfficialPage(URL,{fetch:async()=>new Response(body,{headers:{'content-type':'text/html'}})});
    assert.equal(r.status,'unavailable');
  }
});

test('timeout覆盖fetch和body，不响应取消的注入fetch也能及时退出',async()=>{
  let signal:AbortSignal|undefined;
  const r=await readOfficialPage(URL,{timeoutMs:10,fetch:async(_url,init)=>{signal=init?.signal as AbortSignal;return new Promise<Response>(()=>{});}});
  assert.equal(r.status,'unavailable');assert.equal(signal?.aborted,true);
  let cancelled=false;
  const body=await readOfficialPage(URL,{timeoutMs:10,fetch:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'text/html'}})});
  assert.equal(body.status,'unavailable');assert.equal(cancelled,true);
});

test('显式取消抛出AbortError、不回退不重试，预取消不发请求',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(readOfficialPage(URL,{signal:controller.signal,fetch:async()=>{
    calls++;controller.abort(new DOMException('stop','AbortError'));return response(page('<p>介绍</p>'));
  }}),{name:'AbortError'});
  await assert.rejects(readOfficialPage(URL,{signal:controller.signal,fetch:async()=>{calls++;return response(page('<p>介绍</p>'));}}),{name:'AbortError'});
  assert.equal(calls,1);
});

test('恶意超长标签、深层嵌套不会无限解析',async()=>{
  for(const body of ['<div x="'+'x'.repeat(9000)+'">正文</div>','<div>'.repeat(300)+'正文'+'</div>'.repeat(300)]){
    const r=await read(body);assert.equal(r.status,'unavailable');
  }
});

test('沿用knowledge事件并遵循运行取消',async()=>{
  const events:Array<{type:string;tool?:string;status?:string}>=[];
  await withRun('official-events',createRun(),e=>events.push(e),async()=>{assert.equal((await read('<p>正文</p>')).status,'ready');});
  assert.deepEqual(events.map(e=>[e.tool,e.status]),[['knowledge','started'],['knowledge','completed']]);
  const run=createRun();let calls=0;
  await assert.rejects(withRun('official-cancel',run,()=>{},()=>readOfficialPage(URL,{fetch:async()=>{
    calls++;cancelRun('official-cancel',run.id);return response(page('<p>正文</p>'));
  }})),e=>e instanceof RunStoppedError&&e.status==='cancelled');
  assert.equal(calls,1);
});
