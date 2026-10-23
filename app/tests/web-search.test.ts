import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb, wantsWebSearch, type WebSearchResult } from '../lib/web-search.ts';
import { cancelRun, createRun, withRun, RunStoppedError } from '../lib/agent-runtime.ts';

const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const rss = (body = '') => new Response(`<rss version="2.0"><channel>${body}</channel></rss>`, { headers: { 'content-type': 'text/xml; charset=utf-8' } });
const result = (url = 'https://example.com/article', title = '页面 &amp; 标题', snippet = '一段 <b>真实摘要</b>') =>
  `<div class="result"><a class="result__a" href="${url}">${title}</a><a class="result__snippet">${snippet}</a></div>`;
const feedItem = (url = 'https://example.com/rss', title = 'RSS 标题', description = 'RSS 摘要') =>
  `<item><title>${title}</title><link>${url}</link><description>${description}</description></item>`;

test('DDG优先、提取标题摘要、解开跳转链接，仅请求固定搜索端点', async () => {
  const calls: string[] = [];
  const r: WebSearchResult = await searchWeb('华为 最新 电脑', { fetch: async (url, init) => {
    calls.push(String(url));
    const target = new URL(String(url));
    assert.equal(target.origin + target.pathname, 'https://html.duckduckgo.com/html/');
    assert.equal(target.searchParams.get('q'), '华为 最新 电脑');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return html(result('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle%3Fa%3D1%26b%3D2&amp;rut=abc'));
  } });
  assert.equal(calls.length, 1);
  assert.equal(r.status, 'ready');
  assert.equal(r.provider, 'duckduckgo');
  assert.equal(r.items[0].url, 'https://example.com/article?a=1&b=2');
  assert.equal(r.items[0].title, '页面 & 标题');
  assert.equal(r.items[0].snippet, '一段 真实摘要');
  assert.match(r.items[0].id, /^WEB-[a-f0-9]{24}$/);
  assert.ok(Number.isFinite(Date.parse(r.searchedAt)));
});

test('DDG不同引号、class顺序、数字实体以及div摘要均可解析', async () => {
  const r = await searchWeb('test', { fetch: async () => html(`<a href='https://example.com/' class='other result__a'>A &#38; &#x4e2d;</a><div class='result__snippet more'>摘要&nbsp;内容</div>`) });
  assert.equal(r.items[0].title, 'A & 中');
  assert.equal(r.items[0].snippet, '摘要 内容');
});

test('DDG失败回退Bing RSS并提取CDATA与摘要，绝不读取结果页面', async () => {
  const calls: string[] = [];
  const r = await searchWeb('RSS 测试', { fetch: async (url) => {
    const target = new URL(String(url)); calls.push(target.hostname);
    if (target.hostname === 'html.duckduckgo.com') throw new Error('offline');
    assert.equal(target.origin + target.pathname, 'https://www.bing.com/search');
    assert.equal(target.searchParams.get('format'), 'rss');
    assert.equal(target.searchParams.get('q'), 'RSS 测试');
    return rss(feedItem('<![CDATA[https://example.com/news?a=1&b=2]]>', '<![CDATA[新闻 <b>标题</b>]]>', '新闻 &amp; 摘要'));
  } });
  assert.deepEqual(calls, ['html.duckduckgo.com', 'www.bing.com']);
  assert.equal(r.provider, 'bing');
  assert.equal(r.status, 'ready');
  assert.deepEqual(r.items.map(({title,url,snippet})=>({title,url,snippet})), [{title:'新闻 标题',url:'https://example.com/news?a=1&b=2',snippet:'新闻 & 摘要'}]);
});

test('DDG明确空结果后仍回退Bing，两个合法空页返回empty', async () => {
  let calls = 0;
  const r = await searchWeb('无结果', { fetch: async () => ++calls === 1 ? html('<div class="no-results">无结果</div>') : rss() });
  assert.equal(calls, 2);
  assert.equal(r.status, 'empty');
  assert.equal(r.provider, 'bing');
  assert.deepEqual(r.items, []);
});

test('两个提供方均失败为unavailable，不把验证码页面、坏RSS当作已完成搜索', async () => {
  let calls=0;
  const r = await searchWeb('test', { fetch: async () => ++calls===1 ? html('<form>请验证身份</form>') : new Response('<rss><channel>', {headers:{'content-type':'text/xml'}}) });
  assert.equal(r.status, 'unavailable');
  assert.equal(r.provider, 'none');
  assert.deepEqual(r.items, []);
});

test('有效空结果与另一个不可用提供方区分于全部不可用', async () => {
  let calls=0;
  const r=await searchWeb('test',{fetch:async()=>++calls===1?html('<div class="result--no-result">No results</div>'):new Response('',{status:503})});
  assert.equal(r.status,'empty');
  assert.equal(r.provider,'duckduckgo');
});

test('结果最多6条、去重忽略fragment、编号对同一链接稳定', async () => {
  const content = result('https://example.com/same#first') + result('https://example.com/same#second')
    + Array.from({length:10},(_,i)=>result(`https://example.com/${i}`)).join('');
  const first = await searchWeb('test', {fetch:async()=>html(content)});
  const second = await searchWeb('another', {fetch:async()=>html(result('https://example.com/same'))});
  assert.equal(first.items.length, 6);
  assert.equal(new Set(first.items.map(i=>i.url)).size, 6);
  assert.equal(first.items[0].id, second.items[0].id);
});

test('500字query使用Unicode字符计数，空白不发请求，标题摘要有界', async () => {
  let calls=0;
  const empty=await searchWeb(' \n\0 ',{fetch:async()=>{calls++;throw new Error('must not fetch');}});
  assert.equal(empty.status,'empty');assert.equal(empty.provider,'none');assert.equal(calls,0);
  const r=await searchWeb('😀'.repeat(700),{fetch:async url=>{
    assert.equal(Array.from(new URL(String(url)).searchParams.get('q')!).length,500);
    return html(result('https://example.com/', '题'.repeat(500),'摘'.repeat(2000)));
  }});
  assert.equal(Array.from(r.query).length,500);
  assert.equal(r.items[0].title.length,240);
  assert.equal(r.items[0].snippet.length,1000);
});

test('DDG与RSS都过滤本机、私网、非HTTP、凭证和特殊端口链接', async () => {
  const forbidden=['http://localhost/a','http://localhost./a','http://a.local/','http://metadata.google.internal/',
    'http://intranet/','http://127.0.0.1/','http://2130706433/','http://0x7f000001/', 'http://10.1.2.3/',
    'http://172.16.0.1/','http://192.168.1.1/','http://169.254.169.254/','http://100.64.0.1/','http://0.0.0.0/',
    'http://198.18.0.1/','http://224.0.0.1/','http://[::1]/','http://[::ffff:127.0.0.1]/','http://[fc00::1]/',
    'http://[fe80::1]/','http://[2001:db8::1]/','https://user:password@example.com/', 'https://example.com:8765/',
    'file:///etc/passwd','javascript:alert(1)','data:text/html,hello','/local-result','https://example.com\\@127.0.0.1/'];
  let calls=0;
  const r=await searchWeb('test',{fetch:async()=>++calls===1?html(forbidden.map(u=>result(u)).join(''))
    :rss(forbidden.map(u=>feedItem(u)).join('')+feedItem('https://consumer.huawei.com/cn/'))});
  assert.equal(calls,2); assert.equal(r.status,'ready');assert.equal(r.provider,'bing');
  assert.deepEqual(r.items.map(i=>i.url),['https://consumer.huawei.com/cn/']);
});

test('DDG跳转目标同样过滤私网，协议相对公网站点可用', async () => {
  const r=await searchWeb('test',{fetch:async()=>html(result('//duckduckgo.com/l/?uddg=http%3A%2F%2F127.0.0.1%2F')+result('//example.com/public'))});
  assert.deepEqual(r.items.map(i=>i.url),['https://example.com/public']);
});

test('不跟随HTTP重定向，不接受错误状态和错误内容类型',async()=>{
  for(const bad of [()=>new Response('',{status:302,headers:{location:'http://localhost/'}}),()=>new Response('',{status:429}),()=>new Response('binary',{headers:{'content-type':'image/png'}})]){
    let calls=0;
    const r=await searchWeb('test',{fetch:async(_url,init)=>{assert.equal(init?.redirect,'error');return ++calls===1?bad():rss(feedItem());}});
    assert.equal(r.provider,'bing');assert.equal(calls,2);
  }
});

test('拒绝伪造XML实体，不解析外部文档',async()=>{
  let calls=0;
  const r=await searchWeb('test',{fetch:async()=>++calls===1?new Response('',{status:500}):new Response('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///secret">]><rss><channel><item><title>&x;</title></item></channel></rss>',{headers:{'content-type':'text/xml'}})});
  assert.equal(r.status,'unavailable');assert.equal(calls,2);
});

test('声明长度超过1MiB以及流式实际超限均取消读取并回退',async()=>{
  for(const declared of [true,false]){
    let calls=0, cancelled=false;
    const r=await searchWeb('test',{fetch:async()=>{
      if(++calls===2)return rss(feedItem());
      return new Response(new ReadableStream({start(c){if(!declared)c.enqueue(new Uint8Array(1024*1024+1));},cancel(){cancelled=true;}}),
        {headers:{'content-type':'text/html',...(declared?{'content-length':String(1024*1024+1)}:{})}});
    }});
    assert.equal(r.provider,'bing');assert.equal(cancelled,true);
  }
});

test('超时覆盖fetch，即使注入fetch不响应取消也及时回退',async()=>{
  const keepAlive=setTimeout(()=>{},2000);
  try{
    let calls=0;let firstSignal:AbortSignal|undefined;
    const r=await searchWeb('test',{timeoutMs:15,fetch:async(_url,init)=>{
      if(++calls===1){firstSignal=init?.signal as AbortSignal;return new Promise<Response>(()=>{});}
      return rss(feedItem());
    }});
    assert.equal(firstSignal?.aborted,true);assert.equal(calls,2);assert.equal(r.provider,'bing');
  }finally{clearTimeout(keepAlive);}
});

test('读取慢响应也受超时控制并取消流',async()=>{
  const keepAlive=setTimeout(()=>{},2000);
  try{
    let calls=0,cancelled=false;
    const r=await searchWeb('test',{timeoutMs:15,fetch:async()=>++calls===1
      ?new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'text/html'}}):rss(feedItem())});
    assert.equal(r.provider,'bing');assert.equal(cancelled,true);
  }finally{clearTimeout(keepAlive);}
});

test('显式取消终止当前搜索、不启动fallback',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(searchWeb('test',{signal:controller.signal,fetch:async()=>{
    calls++;controller.abort(new DOMException('Cancelled','AbortError'));return html(result());
  }}),{name:'AbortError'});
  assert.equal(calls,1);
  await assert.rejects(searchWeb('test',{signal:controller.signal,fetch:async()=>{calls++;return html(result());}}),{name:'AbortError'});
  assert.equal(calls,1);
});

test('运行支架停止不吞异常，沿用knowledge进度事件',async()=>{
  const events:Array<{type:string;tool?:string;status?:string}>=[];
  await withRun('web-events',createRun(),e=>events.push(e),async()=>{
    const r=await searchWeb('test',{fetch:async()=>html(result())});assert.equal(r.status,'ready');
  });
  assert.deepEqual(events.map(e=>[e.tool,e.status]),[['knowledge','started'],['knowledge','completed']]);
  const run=createRun();let calls=0;
  await assert.rejects(withRun('web-cancel',run,()=>{},()=>searchWeb('test',{fetch:async()=>{
    calls++;cancelRun('web-cancel',run.id);return html(result());
  }})),e=>e instanceof RunStoppedError&&e.status==='cancelled');
  assert.equal(calls,1);
});

test('显式联网、最新和现价触发；普通库搜索和否定联网不触发',()=>{
  for(const s of ['帮我联网搜索华为电脑','联网查资料','请上网查一下','网络搜索这款产品','搜索网页','查一下网页',
    '查最新发布的电脑','看看现价','查实时价格','当前价格是多少','web search Huawei','search the web for laptops']) assert.equal(wantsWebSearch(s),true,s);
  for(const s of ['库搜索办公电脑','帮我选电脑','查产品参数','预算七千','不要联网，告诉我最新消息','不用联网搜索','不联网','别上网查',
    '无需网络搜索','只用本地资料查最新','仅查知识库','不要最新消息','不要现价','do not web search','without internet']) assert.equal(wantsWebSearch(s),false,s);
});
