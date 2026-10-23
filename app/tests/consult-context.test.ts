import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectConsultEvidence } from '../lib/consult-context.ts';
import type { Evidence } from '../lib/facts.ts';
const rows = Array.from({length:106}, (_,i)=>({id:`E${i}`,kind:'fact',section:'外观',text:`外观描述${i}`} as Evidence));
rows[77]={...rows[77],section:'接口',text:'HDMI × 1'};
rows[74]={...rows[74],section:'接口',text:'USB-C 3.2 Gen 1 × 1'};
test('late interface rows survive the fixed context budget for interface questions',()=>{
  const chosen=selectConsultEvidence(rows,'D14 2024有哪些接口，接U盘和HDMI投影？',()=>0);
  assert.equal(chosen.length,65);assert.ok(chosen.some(e=>e.id==='E77'));assert.ok(chosen.some(e=>e.id==='E74'));
});
test('unrelated and empty queries retain stable ordering without mutating input',()=>{
  assert.deepEqual(selectConsultEvidence(rows,'',()=>0),rows.slice(0,65));
  assert.equal(rows[0].id,'E0');
});
