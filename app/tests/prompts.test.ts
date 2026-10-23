import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGE_RANGE, type Platform } from '../lib/check.ts';
import { PLATFORM_SPEC, REQUIRED_FOOTER, SYSTEM_PROMPT } from '../lib/prompts.ts';
import { MARKETING_SCENARIO_GUIDANCE, buildMarketingPlatformGuidance } from '../lib/scenario-guidance.ts';

test('平台长度、段落、配图及尾注契约保持原规格', () => {
  assert.deepEqual(Object.keys(PLATFORM_SPEC).sort(), ['公众号', '小红书', '朋友圈'].sort());
  for (const platform of Object.keys(IMAGE_RANGE) as Platform[]) {
    const [min, max] = IMAGE_RANGE[platform];
    assert.ok(PLATFORM_SPEC[platform].includes(`图片 ${min}-${max} 张`));
  }
  assert.match(PLATFORM_SPEC.小红书, /350-550 字.*3 段/);
  assert.match(PLATFORM_SPEC.小红书, /标签 6-9 个/);
  assert.match(PLATFORM_SPEC.小红书, /结尾.*可回答的问题/);
  assert.match(PLATFORM_SPEC.公众号, /标题 18-26 字.*1 个标题.*导语 48-64 字/);
  assert.match(PLATFORM_SPEC.公众号, /900-1300 字.*3 个小标题/);
  assert.match(PLATFORM_SPEC.公众号, /图注 18-36 字/);
  assert.match(PLATFORM_SPEC.朋友圈, /全文 90-150 字/);
  assert.match(PLATFORM_SPEC.朋友圈, /至多 3 个参数.*版本条件.*不超过 3 个/);
  assert.equal(REQUIRED_FOOTER, '不同版本配置可能不同，购买前请确认对应的官方规格。');
});

// 这层只防止编辑要求意外删掉关键边界，不宣称模型已经遵守或文案质量已提升。
test('决策分支与身份、价格、图文证据边界共同保留', () => {
  for (const requirement of [
    /需求未定.*比较候选.*接近购买/s,
    /阶段未知不擅自写成马上下单/,
    /不冒充消费者.*不虚构朋友口碑/,
    /硬约束.*影响本次决定的证据/s,
    /只能来自.*证据清单/,
    /历史价格保留证据原日期/,
    /型号必须一致.*不得用生成图/s,
    /未复核只用中性图注/,
    /覆盖标题、导语、正文、CTA 与图注/,
    /改稿时保留型号、系统、证据与图片边界/,
  ]) assert.match(SYSTEM_PROMPT, requirement);
});

// 在空工作目录和显式虚构环境中导入真实调用链；不继承或读取本机私密设置。
// fetch 完全由替身接管，只接受预定地址；返回的是格式夹具，不是模型创作样本。
const offlineRunner = String.raw`
import assert from 'node:assert/strict';
const {newSession, writeFromNeed, reviseDraft} = await import(process.argv[1]);
const models = [
  {id:'pro-s',name:'HUAWEI MateBook Pro S',system:'HarmonyOS 6.1',ready:true},
  {id:'d14',name:'HUAWEI MateBook D 14 2024',system:'Windows / Linux（需确认配置）',ready:true},
];
const cases = [
  {id:'student-unknown',platform:'小红书',modelId:'d14',audience:'大学新生与家长',scene:'课程尚未确定，判断是否现在换电脑',
    facts:['旧电脑仍可完成当前作业','目前需求未定'],unknowns:['课程软件名称和系统要求']},
  {id:'student-ready',platform:'朋友圈',modelId:'d14',audience:'软件要求已明确的学生',scene:'准备购买，确认课堂展示连接',
    facts:['已向老师确认软件版本和系统要求','已准备下单，只差确认连接方式'],unknowns:['教室设备与线材']},
  {id:'travel-software',platform:'公众号',modelId:'pro-s',audience:'经常出差的业务人员',scene:'比较候选，必用软件有系统限制',
    facts:['公司软件只提供特定系统版本','正在比较候选'],unknowns:['该软件是否适配本型号的系统版本']},
  {id:'travel-ready',platform:'小红书',modelId:'pro-s',audience:'商务差旅人员',scene:'准备购买，已有外设，确认具体配置',
    facts:['会议室使用HDMI设备','已经列好软件和外设清单','接近购买'],unknowns:['转接设备与目标配置的连接情况']},
  {id:'student-compare',platform:'公众号',modelId:'d14',audience:'每天携带电脑上课的学生',scene:'比较候选，取舍携带负担与课堂连接',
    facts:['每天带充电器和课本','在比较候选'],unknowns:['是否能接受整包重量']},
  {id:'travel-unknown',platform:'朋友圈',modelId:'pro-s',audience:'刚开始出差的职场新人',scene:'用途未定，暂不确定是否换电脑',
    facts:['旧电脑目前够用','尚未决定购买'],unknowns:['必用办公软件与外设版本']},
];
const results=[];
for (const scenario of cases) {
  const model=models.find(m=>m.id===scenario.modelId);
  const evidence=[{
    id:'E001',docId:'offline-fact',docTitle:'产品事实',docPath:model.id+'/fixture.md',
    line:1,section:'版本条件',text:model.id+'：仅测试配置A列有接口X，其他配置待确认。',
    kind:'fact',source:'本地已下载知识库',readAt:'2026-10-19T00:00:00Z',
  }];
  const images=Array.from({length:6},(_,n)=>({
    id:'IMG'+(n+1),filename:'offline-'+n+'.png',docId:model.id+'-image-'+n,
    modelId:model.id,modelName:model.name,purpose:'索引功能类别不作画面证据',
    caption:n===0?'合盖外观':'未复核索引说明',visuallyReviewed:n===0,
    width:1080,height:1440,source:'本地已下载知识库',url:'http://127.0.0.1/offline-image-'+n,
  }));
  const sources={
    models,
    loadEvidence:async id=>{assert.equal(id,model.id);return evidence;},
    loadImages:async id=>{assert.equal(id,model.id);return images;},
  };
  const requests=[];
  const count={'公众号':2,'小红书':3,'朋友圈':1}[scenario.platform];
  globalThis.fetch=async(url,init)=>{
    assert.equal(String(url),'http://127.0.0.1:19279/v1/chat/completions');
    const request=JSON.parse(String(init.body));
    requests.push(request.messages);
    const verifying=request.messages[0].content.includes('严格的事实核验模块');
    const data=verifying?{issues:[],verified_claim_ids:['C1']}:{
      title:'离线格式夹具',lead:'',body:model.name+'：仅测试配置A列有接口X，其他配置待确认。',
      cta:'不同销售版本配置可能不同，请以华为官方规格页及实际销售 SKU 为准。',
      tags:[],images:images.slice(0,count).map(i=>({imageId:i.id,position:'正文后',caption:'产品配图'})),
      claims:[{id:'C1',text:'仅测试配置A列有接口X，其他配置待确认。',factIds:['E001']}],
    };
    return Response.json({choices:[{message:{content:JSON.stringify(data)}}]});
  };
  const session={...newSession(),modelId:model.id,modelName:model.name};
  const need={
    intent:'create',platform:scenario.platform,audience:scenario.audience,scene:scenario.scene,
    facts_from_user:scenario.facts,unknowns:scenario.unknowns,
    unsupported_requests:['无证据的当前优惠'],next_action:'write',
  };
  const events=[];
  await writeFromNeed(need,'按已确认需求创作，不加入优惠',session,e=>events.push(e),sources);
  assert.ok(session.draft,'真实写稿入口应产生可读取的格式夹具');
  const first=structuredClone(session.draft);
  const instruction='只让表达更口语；不要加入亲测、实时优惠或全天续航。';
  await reviseDraft(instruction,session,e=>events.push(e),sources);
  assert.ok(session.draft,'真实改稿入口应产生可读取的格式夹具');
  assert.equal(requests.length,4,'写稿和改稿各触发一次独立核验');
  assert.equal(events.filter(e=>e.type==='draft').length,2);
  assert.equal(events.filter(e=>e.type==='check').length,2);
  results.push({
    scenario,model,evidenceText:evidence[0].text,instruction,
    first,next:session.draft,report:session.report,
    write:requests[0],revise:requests[2],
    verifierSystems:[requests[1][0].content,requests[3][0].content],
  });
}
console.log(JSON.stringify(results));
`;

test('六种任务经真实写稿和改稿入口保留平台、阶段、证据、版本及旧稿上下文', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'zhixuan-prompts-offline-'));
  const env: NodeJS.ProcessEnv = {
    OPENAI_NEXT_API_KEY: 'offline-test-placeholder',
    LLM_BASE_URL: 'http://127.0.0.1:19279/v1',
    LLM_MODELS: 'offline-fixture',
  };
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  try {
    const child = spawnSync(process.execPath, [
      '--experimental-strip-types', '--input-type=module', '--eval',
      offlineRunner, new URL('../lib/agent.ts', import.meta.url).href,
    ], { cwd: workspace, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const results = JSON.parse(child.stdout);
    assert.equal(results.length, 6);
    const expectedFields = ['version', 'platform', 'modelId', 'modelName', 'title', 'lead', 'body', 'cta', 'tags', 'images', 'claims'].sort();
    for (const result of results) {
      const platform = result.scenario.platform as Platform;
      for (const messages of [result.write, result.revise]) {
        assert.ok(messages[0].content.startsWith(SYSTEM_PROMPT));
        assert.ok(messages[0].content.includes(MARKETING_SCENARIO_GUIDANCE));
        assert.ok(messages[0].content.includes(buildMarketingPlatformGuidance(platform)));
        const user = messages[1].content as string;
        for (const required of [
          PLATFORM_SPEC[platform], REQUIRED_FOOTER, result.scenario.scene,
          result.scenario.audience, ...result.scenario.facts, ...result.scenario.unknowns,
          result.model.name, result.model.system, result.evidenceText,
          '无证据的当前优惠', '已人工看图复核；实际画面描述=合盖外观',
          '未人工看图复核', '"factIds":["E001"]',
        ]) assert.ok(user.includes(required), `${result.scenario.id} 丢失任务信息：${required}`);
      }
      const revisedUser = result.revise[1].content as string;
      assert.ok(revisedUser.includes(result.instruction));
      assert.ok(revisedUser.includes('现有稿件（版本 1）'));
      assert.ok(revisedUser.includes(result.first.body));
      for (const draft of [result.first, result.next]) {
        assert.deepEqual(Object.keys(draft).sort(), expectedFields);
        assert.equal(draft.platform, platform);
        assert.equal(draft.modelId, result.model.id);
        assert.deepEqual(Object.keys(draft.images[0]).sort(), ['caption', 'imageId', 'position']);
        assert.deepEqual(Object.keys(draft.claims[0]).sort(), ['factIds', 'id', 'text']);
        assert.deepEqual(draft.claims[0].factIds, ['E001']);
      }
      assert.equal(result.next.version, 2);
      assert.equal(result.report.draftVersion, 2);
      assert.ok(result.verifierSystems.every((text: string) => text.includes('严格的事实核验模块')));
    }
  } finally {
    // 目录由本测试创建且保持为空；不用递归删除，避免触及任何其他文件。
    rmdirSync(workspace);
  }
});
