import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve('../output/demo-20261023/preflight-refinement');
await mkdir(out,{recursive:true});
const cases=[
 {id:'moments',sessionId:'final-moments-travel-1792739864888',message:'这版全文偏长。正文压缩到80字以内，只保留标准屏版重量及实际测量差异，不写系统、屏幕、接口或使用效果，不推断减负、省力。保留原来的两张库图、顺序和图注。标题、导语和标签留空；必要的通用版本提示放在CTA一次，全文控制在90—150字。'},
 {id:'xhs',sessionId:'final-xhs-student-1792739864915',message:'按内容建议重写这一版。删去“更接近A4纸”“多显示几行”“分屏够用”“外设大多能直接插”等没有依据的效果和兼容承诺；只保留证据明确的版本参数与接口。正文350—550字，恰好三段：先说课程报告与软件要求如何决定候选，再说去教室要考虑的具体接口与携带条件，最后给出课程软件未知时下一步怎么试，不宣称省力、流畅或兼容。不要用“最好”“唯一”。保留原来的3张库图，图注仅描述已知画面；结尾自然，标签6个。'},
 {id:'wechat',sessionId:'final-wechat-travel-1792739864916',message:'重试上一条完整公众号任务，仍是MateBook Pro S、差旅办公人群。正文900—1300字，不计标题、导语、CTA、图注和标签，三节各围绕一个问题写300—400字：第一节解释先列出哪些具体软件与文件任务、为什么版本未知时不能直接承诺；第二节围绕会议投影、USB-A外设和出差行李，解释已知接口和重量版本的取舍及未确认项；第三节写到店如何用自己的文件、外设逐步验证，并说明通过或不通过时分别怎么决定。使用现有资料和三张产品图，不写测评结论、价格或减负效果，不把“去核对”在每段机械重复。每节提供不同的具体选择帮助，保留必要事实条件。标题18—26字、导语48—64字。'}
];
const results=[];
for(const item of cases){
 const entry={...item};results.push(entry);const begin=Date.now();
 try{const response=await fetch('http://127.0.0.1:3100/api/agent',{method:'POST',headers:{'content-type':'application/json',accept:'text/event-stream'},body:JSON.stringify({sessionId:item.sessionId,message:item.message}),signal:AbortSignal.timeout(300000)});
 entry.http=response.status; const wire=await response.text();await writeFile(path.join(out,item.id+'.sse'),wire,{flag:'wx'});
 const snapshot=await(await fetch('http://127.0.0.1:3100/api/agent?sessionId='+item.sessionId)).json();await writeFile(path.join(out,item.id+'.snapshot.json'),JSON.stringify(snapshot,null,2),{flag:'wx'});
 const exported=await fetch('http://127.0.0.1:3100/api/export?sessionId='+item.sessionId);entry.exportStatus=exported.status;await writeFile(path.join(out,item.id+'.export.json'),JSON.stringify(await exported.json(),null,2),{flag:'wx'});
 const d=snapshot.view?.draft;entry.status=snapshot.run?.status;entry.bodyCount=[...(d?.body??'')].length;entry.version=d?.version;entry.issues=snapshot.view?.report?.issues;entry.imageCount=d?.images?.length;
 }catch(error){entry.error=error.message;}entry.ms=Date.now()-begin;await writeFile(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(entry));
}
