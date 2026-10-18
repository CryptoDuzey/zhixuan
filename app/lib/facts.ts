// 事实层：型号注册、证据单元（按行切分、带稳定编号）、图片绑定。只通过 ima 客户端读取。
import { findLocal, readLocalText, type LocalDoc, type SourceKind } from './ima.ts';

export interface ModelEntry {
  id: string;
  name: string;
  system: string;
  ready: boolean; // 事实、图片、平台卡是否齐备
  dir?: string; // 本地路径片段
  sceneDir?: string;
  priceTitle?: string;
  note?: string;
}

export const MODELS: ModelEntry[] = [
  { id: 'pro-s', name: 'HUAWEI MateBook Pro S', system: 'HarmonyOS 6.1', ready: true, dir: 'P1-产品参数库/01-鸿蒙电脑/HUAWEI MateBook Pro S/', sceneDir: 'HUAWEI MateBook Pro S/', priceTitle: 'HUAWEI MateBook Pro S-价格卡.md' },
  { id: 'mb14-harmony', name: 'HUAWEI MateBook 14（鸿蒙电脑）', system: 'HarmonyOS', ready: true, dir: 'P1-产品参数库/01-鸿蒙电脑/HUAWEI MateBook 14/', sceneDir: 'HUAWEI MateBook 14/', priceTitle: 'HUAWEI MateBook 14（鸿蒙版）-价格卡.md', note: '同系列名另有 Windows 版本，需先澄清' },
  { id: 'mb14-ultra', name: 'MateBook 14 酷睿 Ultra（Windows）', system: 'Windows', ready: true, dir: 'P1-产品参数库/02-MateBook-Windows/MateBook 14 酷睿 Ultra/', sceneDir: 'MateBook 14 酷睿 Ultra/', priceTitle: 'HUAWEI MateBook 14 酷睿 Ultra-价格卡.md', note: '同系列名另有鸿蒙版本，需先澄清' },
  { id: 'd14', name: 'HUAWEI MateBook D 14 2024', system: 'Windows / Linux（需确认配置）', ready: true, dir: 'P1-产品参数库/02-MateBook-Windows/MateBook D 14/', sceneDir: 'MateBook D 14/', priceTitle: 'HUAWEI MateBook D 14 2024-价格卡.md' },
  { id: 'd16', name: 'HUAWEI MateBook D 16 2024', system: 'Windows（需确认配置）', ready: true, dir: 'P1-产品参数库/02-MateBook-Windows/MateBook D 16/', sceneDir: 'MateBook D 16/', priceTitle: 'HUAWEI MateBook D 16 2024-价格卡.md' },
];

export function ambiguousModel(text: string): ModelEntry[] | null {
  const t = text.replace(/\s+/g, '').toLowerCase();
  if (/matebook14/.test(t) && !/酷睿|ultra|windows|鸿蒙|harmony/.test(t)) {
    return MODELS.filter((m) => m.id.startsWith('mb14'));
  }
  return null;
}

export type EvidenceKind = 'fact' | 'limit' | 'price' | 'scene' | 'rule';

export interface Evidence {
  id: string; // E001…
  docId: string;
  docTitle: string;
  docPath: string;
  line: number;
  section: string;
  text: string;
  kind: EvidenceKind;
  source: SourceKind;
  readAt: string;
}

export interface ImageRef {
  id: string; // IMG1…
  filename: string;
  docId: string;
  modelId: string;
  modelName: string;
  caption: string; // 已复核时使用实际画面描述，否则保留索引说明
  purpose: string;
  visuallyReviewed?: boolean;
  width: number;
  height: number;
  source: SourceKind;
  url: string;
}

interface DocSpec {
  fragments: string[];
  kind: EvidenceKind;
  label: string;
}

function modelDocs(model: ModelEntry): DocSpec[] {
  if (!model.ready || !model.dir || !model.sceneDir || !model.priceTitle) throw new Error('该型号资料尚未接入');
  const scene = `P2-卖点话术库/07-按型号角色/${model.sceneDir}`;
  return [
    { fragments: [`${model.dir}产品事实.md`], kind: 'fact', label: '产品事实' },
    { fragments: [`${model.dir}卖点与限制.md`], kind: 'limit', label: '卖点与限制' },
    { fragments: ['08-官方公开价格快照/', model.priceTitle], kind: 'price', label: '价格卡' },
    { fragments: [`${scene}商务差旅用户沟通卡.md`], kind: 'scene', label: '商务差旅沟通卡' },
    { fragments: [`${scene}学生用户沟通卡.md`], kind: 'scene', label: '学生用户沟通卡' },
  ];
}

const RULE_DOCS: DocSpec[] = [{ fragments: ['售后与促销表述红线'], kind: 'rule', label: '售后与促销表述红线' }];

function split(doc: LocalDoc, text: string, spec: DocSpec, start: number, readAt: string): Evidence[] {
  const out: Evidence[] = [];
  let section = '';
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let label = '';
  lines.forEach((raw, i) => {
    let line = raw.trim();
    if (!line) return;
    if (line.startsWith('#')) {
      section = line.replace(/^#+\s*/, '');
      label = '';
      return;
    }
    // 规格页是“标签 / 值”分行的纯文本：短标签并入下一行，使每条证据可独立阅读
    if (spec.kind === 'fact' && /^[^\d，。：:*]{1,8}$/.test(line)) {
      label = line;
      return;
    }
    if (label) {
      line = `${label}：${line}`;
      label = '';
    }
    if (line.length < 4) return;
    if (/即将离开|即将跳转|第三方页面|consumer\.huawei\.com/.test(line)) return;
    out.push({
      id: `E${String(start + out.length + 1).padStart(3, '0')}`,
      docId: doc.id,
      docTitle: spec.label,
      docPath: doc.path,
      line: i + 1,
      section,
      text: line.replace(/^[-*]\s*/, ''),
      kind: spec.kind,
      source: '本地已下载知识库',
      readAt,
    });
  });
  return out;
}

const evidenceCache = new Map<string, Evidence[]>();

export async function loadEvidence(modelId: string, opts: { withRules?: boolean } = {}): Promise<Evidence[]> {
  const key = `${modelId}|${opts.withRules ? 1 : 0}`;
  const hit = evidenceCache.get(key);
  if (hit) return hit;
  const model = MODELS.find((m) => m.id === modelId);
  if (!model) throw new Error('型号资料尚未接入');
  const specs = [...modelDocs(model), ...(opts.withRules ? RULE_DOCS : [])];
  const all: Evidence[] = [];
  for (const spec of specs) {
    const doc = await findLocal(...spec.fragments);
    if (!doc) throw new Error(`找不到资料：${spec.label}`);
    const r = await readLocalText(doc);
    if (!r.ok || !r.text) throw new Error(`读取失败：${spec.label}`);
    all.push(...split(doc, r.text, spec, all.length, r.readAt));
  }
  evidenceCache.set(key, all);
  return all;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** 只覆盖实际打开原图确认过的文件，不把文件名类别当作画面证据。 */
export const REVIEWED_IMAGE_DESCRIPTIONS: Record<string, string> = {
  'hwpc_matebook-d-14-2024_高清护眼屏幕_01_9cbdf422.png': '电脑打开时的正面外观，屏幕显示彩色壁纸；画面不能证明护眼效果',
  'hwpc_matebook-pro-s_多彩配色外观_05_0f907e31.jpg': '紫色机身打开时的侧面外观，画面没有人物',
  'hwpc_matebook-pro-s_精致产品细节_01_9e99c213.jpg': '紫色机身合盖外观',
  'hwpc_matebook-pro-s_智慧协同功能_03_076021a9.jpg': '多人在桌边使用电脑的场景；画面本身不能证明具体协同功能',
};

export async function loadImages(modelId: string): Promise<ImageRef[]> {
  const model = MODELS.find((m) => m.id === modelId && m.ready);
  if (!model?.dir) return [];
  const idxDoc = await findLocal(`${model.dir}图片索引.csv`);
  if (!idxDoc) throw new Error('找不到图片索引');
  const r = await readLocalText(idxDoc);
  if (!r.ok || !r.text) throw new Error('读取图片索引失败');
  const rows = r.text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).slice(1).map(parseCsvLine);
  const refs: ImageRef[] = [];
  for (const [i, c] of rows.entries()) {
    const [filename, modelName, , url, caption, w, h] = c;
    const doc = await findLocal(`${model.dir}images/`, filename);
    if (!doc) continue;
    const purpose = filename.replace(/^hwpc_[^_]+_/, '').replace(/_\d+_[0-9a-f]+\.jpg$/, '');
    const reviewed = REVIEWED_IMAGE_DESCRIPTIONS[filename];
    refs.push({
      id: `IMG${i + 1}`,
      filename,
      docId: doc.id,
      modelId,
      modelName,
      caption: reviewed ?? caption.trim(),
      purpose: reviewed ? '已核对原图的画面描述' : purpose,
      visuallyReviewed: !!reviewed,
      width: Number(w),
      height: Number(h),
      source: '本地已下载知识库',
      url,
    });
  }
  return refs;
}
