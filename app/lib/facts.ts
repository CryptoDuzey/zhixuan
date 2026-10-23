// 事实层：型号注册、证据单元（按行切分、带稳定编号）、图片绑定。只通过 ima 客户端读取。
import { findLocal, loadLocalIndex, readLocalText, type LocalDoc, type SourceKind } from './ima.ts';

export interface ModelEntry {
  id: string;
  name: string;
  system: string;
  ready: boolean; // 事实、图片、平台卡是否齐备
  dir?: string; // 本地路径片段
  sceneDir?: string;
  priceTitle?: string;
  imageModelName?: string; // 新接入清单的精确产品身份，不从目录名或文件名猜测。
  note?: string;
}

export const MODELS: ModelEntry[] = [
  { id: 'pro-s', name: 'HUAWEI MateBook Pro S', system: 'HarmonyOS 6.1', ready: true, dir: 'P1-产品参数库/01-鸿蒙电脑/HUAWEI MateBook Pro S/', sceneDir: 'HUAWEI MateBook Pro S/', priceTitle: 'HUAWEI MateBook Pro S-价格卡.md' },
  { id: 'mb14-harmony', name: 'HUAWEI MateBook 14（鸿蒙电脑）', system: 'HarmonyOS', ready: true, dir: 'P1-产品参数库/01-鸿蒙电脑/HUAWEI MateBook 14/', sceneDir: 'HUAWEI MateBook 14/', priceTitle: 'HUAWEI MateBook 14（鸿蒙版）-价格卡.md', note: '同系列名另有 Windows 版本，需先澄清' },
  { id: 'mb14-ultra', name: 'MateBook 14 酷睿 Ultra（Windows）', system: 'Windows', ready: true, dir: 'P1-产品参数库/02-MateBook-Windows/MateBook 14 酷睿 Ultra/', sceneDir: 'MateBook 14 酷睿 Ultra/', priceTitle: 'HUAWEI MateBook 14 酷睿 Ultra-价格卡.md', note: '同系列名另有鸿蒙版本，需先澄清' },
  { id: 'd14', name: 'HUAWEI MateBook D 14 2024', system: 'Windows / Linux（需确认配置）', ready: true, dir: 'P1-产品参数库/02-MateBook-Windows/MateBook D 14/', sceneDir: 'MateBook D 14/', priceTitle: 'HUAWEI MateBook D 14 2024-价格卡.md' },
  { id: 'd16', name: 'HUAWEI MateBook D 16 2024', system: 'Windows（需确认配置）', ready: true, dir: 'P1-产品参数库/02-MateBook-Windows/MateBook D 16/', sceneDir: 'MateBook D 16/', priceTitle: 'HUAWEI MateBook D 16 2024-价格卡.md' },
  { id: 'fold-ultimate', name: 'HUAWEI MateBook Fold 非凡大师', system: 'HarmonyOS 6.1', ready: true, dir: 'P1-产品参数库/01-鸿蒙电脑/HUAWEI MateBook Fold 非凡大师/', sceneDir: 'HUAWEI MateBook Fold 非凡大师/', priceTitle: 'HUAWEI MateBook Fold 非凡大师-价格卡.md', imageModelName: 'HUAWEI MateBook Fold 非凡大师', note: '仅对应非凡大师；不含企业版。图片未逐图复核，空图注行不采用。' },
  { id: 'pro-harmony', name: 'HUAWEI MateBook Pro', system: 'HarmonyOS 6.1', ready: true, dir: 'P1-产品参数库/01-鸿蒙电脑/HUAWEI MateBook Pro/', sceneDir: 'HUAWEI MateBook Pro/', priceTitle: 'HUAWEI MateBook Pro（鸿蒙版）-价格卡.md', imageModelName: 'HUAWEI MateBook Pro', note: '仅对应鸿蒙版Pro，不是Pro S。图片未逐图复核，空图注行不采用。' },
  { id: 'd16-se', name: 'HUAWEI MateBook D 16 SE 版 2024', system: 'Windows / Linux（需确认配置）', ready: false, dir: 'P1-产品参数库/02-MateBook-Windows/MateBook D 16 SE 版/', sceneDir: 'MateBook D 16 SE 版/', priceTitle: 'HUAWEI MateBook D 16 SE 版 2024-价格卡.md', imageModelName: 'HUAWEI MateBook D 16 SE 版 2024', note: '暂不接入创作：事实尺寸字段错位，部分原图注指向非SE的D16；需修正事实并确认图片适用版本。' },
  { id: 'gt14', name: 'HUAWEI MateBook GT 14', system: 'Windows / Linux（需确认配置）', ready: true, dir: 'P1-产品参数库/02-MateBook-Windows/MateBook GT 系列/', sceneDir: 'MateBook GT 系列/', priceTitle: 'HUAWEI MateBook GT 14-价格卡.md', imageModelName: 'HUAWEI MateBook GT 14', note: '目录GT系列仅对应已收录GT 14，不泛化到其他年份/型号；保留Windows与Linux条件，图片未逐图复核。' },
  { id: 'xpro-ultra-premium', name: 'HUAWEI MateBook X Pro 酷睿 Ultra 微绒典藏版', system: 'Windows / Linux（需确认配置）', ready: false, dir: 'P1-产品参数库/02-MateBook-Windows/MateBook X系列/', sceneDir: 'MateBook X系列/', priceTitle: 'HUAWEI MateBook X Pro 酷睿 Ultra 微绒典藏版-价格卡.md', imageModelName: 'HUAWEI MateBook X Pro 酷睿 Ultra 微绒典藏版', note: '暂不接入创作：事实尺寸字段把13.5mm列为长度、222mm列为厚度，与限制资料冲突；待修正。不能泛化到全部X系列。' },
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
  sha256?: string; // 本稿取图时目录提供的内容版本；旧记录可能没有。
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
  'hwpc_matebook-pro-s_多彩配色外观_06_d792d65d.jpg': '紫色电脑打开时的正面外观，屏幕显示紫色抽象壁纸，画面没有人物',
  'hwpc_matebook-pro-s_长续航快充场景_04_6f60ddb8.jpg': '女士在户外躺椅上使用紫色电脑，旁边有狗；画面不能证明续航或快充效果',
  'hwpc_matebook-pro-s_高清护眼屏幕_02_f55ba57d.jpg': '浅金色电脑合盖时的低角度外观；画面没有展示屏幕，不能证明护眼效果',
  'hwpc_matebook-d-14-2024_轻薄机身细节_03_f95df550.png': 'Intel Core i5 标识示意图；不是电脑机身照片，不能据此确认具体配置',
  'hwpc_matebook-d-14-2024_智慧协同功能_02_1ddd3013.png': '电脑与手机、耳机、平板、显示设备连接的示意图；不代表所有设备均兼容',
  'hwpc_matebook-d-14-2024_高清护眼屏幕_04_a03d1eae.png': '彩色壁纸与柔和阴影的抽象图形，没有电脑机身；不能证明护眼效果',
  'hwpc_matebook-d-14-2024_高清护眼屏幕_05_f84041e5.png': '视频编辑界面截图，包含时间轴和风景预览；不能作为软件兼容或性能证明',
  'hwpc_matebook-d-14-2024_高清护眼屏幕_06_f4903c68.png': '标有 90% 和斜线的图形；缺少指标解释，不能据此推断参数含义',
  'hwpc_matebook-d-14-2024_高清护眼屏幕_07_8de85af9.png': '电脑打开时的正面外观，屏幕为黑色并带投影；不能证明显示或性能效果',
  'hwpc_matebook-d-14-2024_高清护眼屏幕_01_9cbdf422.png': '电脑打开时的正面外观，屏幕显示彩色壁纸；画面不能证明护眼效果',
  'hwpc_matebook-pro-s_多彩配色外观_05_0f907e31.jpg': '紫色机身打开时的侧面外观，画面没有人物',
  'hwpc_matebook-pro-s_精致产品细节_01_9e99c213.jpg': '紫色机身合盖外观',
  'hwpc_matebook-pro-s_智慧协同功能_03_076021a9.jpg': '多人在桌边使用电脑的场景；画面本身不能证明具体协同功能',
};

// SHA-256 of local originals visually rechecked on 2026-10-20.
// A familiar filename alone must never confer reviewed status on changed bytes.
const REVIEWED_IMAGE_HASHES: Record<string, string> = {
  'hwpc_matebook-pro-s_多彩配色外观_06_d792d65d.jpg': '8df67bfab9c9d91af866526a5a7e82b74885b5399115202e170593b9e1a88bf1',
  'hwpc_matebook-pro-s_长续航快充场景_04_6f60ddb8.jpg': 'd0e45db5dc74d9d42e75eea7aa94224c27a8788d4b238efd8b4dc8466d3b42e8',
  'hwpc_matebook-pro-s_高清护眼屏幕_02_f55ba57d.jpg': '4fd3d4c0ebc9ff6fae83c74ad4f9f1a335186e599010a36304c7da2c1d64d256',
  'hwpc_matebook-d-14-2024_轻薄机身细节_03_f95df550.png': '5a768865a483be382b627eac6f88806e2a098d171a9cd9d7ac8716b9f8579ca1',
  'hwpc_matebook-d-14-2024_智慧协同功能_02_1ddd3013.png': '161572cf649f168b342c1d8ee66b2dd98bd0a8ab3f182c0eef9a3e4f7c9fee7e',
  'hwpc_matebook-d-14-2024_高清护眼屏幕_04_a03d1eae.png': '53781651c6f0027c32f9ead10d06c9fc3a2b4269af09fad8aed65e1b9255e6e0',
  'hwpc_matebook-d-14-2024_高清护眼屏幕_05_f84041e5.png': '823cf134fee72fcd929fa03aeb99860a32c7eeb32cc90ef551ef43a04f7be73c',
  'hwpc_matebook-d-14-2024_高清护眼屏幕_06_f4903c68.png': '0fb0a6d574d7b5ad3d91605d88f72ca3087ee497d172b8dd84458d36f93ecb53',
  'hwpc_matebook-d-14-2024_高清护眼屏幕_07_8de85af9.png': '7fdbb0266f50aacb2001a1ffb3a2cff7b231df5c41e6be30dda169e821c2ae35',
  'hwpc_matebook-d-14-2024_高清护眼屏幕_01_9cbdf422.png': 'bb5dccd7a1f0c440e123a37563c56c67b8756be4dd15a330b87a8aa0d6824307',
  'hwpc_matebook-pro-s_多彩配色外观_05_0f907e31.jpg': '88477e9fb10790da1068abd21fafb341cb79cbd415bb0cc4129bdca3e3ed9c16',
  'hwpc_matebook-pro-s_精致产品细节_01_9e99c213.jpg': '8a3b93e9b7df3fe13cb958e14726db8f76d871e6507774c4fec9a45a768f2826',
  'hwpc_matebook-pro-s_智慧协同功能_03_076021a9.jpg': '2d7d2da727f726550085a11d54d0297b6dfd6bd5e5668fb65190f621c37fd3fa',
};

export async function loadImages(modelId: string): Promise<ImageRef[]> {
  const model = MODELS.find((m) => m.id === modelId && m.ready);
  if (!model?.dir) return [];
  const directory = await loadLocalIndex({ refresh: true });
  const locate = (path: string) => {
    const matches = directory.filter(doc => {
      const normalized = doc.path.replaceAll('\\', '/');
      return normalized === path || normalized.endsWith(`/${path}`);
    });
    return matches.length === 1 ? matches[0] : undefined;
  };
  const idxDoc = locate(`${model.dir}图片索引.csv`);
  if (!idxDoc) throw new Error('找不到图片索引');
  const r = await readLocalText(idxDoc, { refresh: true });
  if (!r.ok || !r.text) throw new Error('读取图片索引失败');
  const rows = r.text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).slice(1).map(parseCsvLine);
  const refs: ImageRef[] = [];
  for (const [i, c] of rows.entries()) {
    const [filename, modelName, , url, caption, w, h] = c;
    // An index row names one file, never a substring, nested path or URL.
    if (!filename || /[\\/]/.test(filename) || filename === '.' || filename === '..') continue;
    if (model.imageModelName && modelName?.trim() !== model.imageModelName) continue;
    if (![Number(w), Number(h)].every(value => Number.isFinite(value) && value > 0)) continue;
    const doc = locate(`${model.dir}images/${filename}`);
    if (!doc) continue;
    const reviewed = typeof doc.sha256 === 'string' && REVIEWED_IMAGE_HASHES[filename] === doc.sha256.toLowerCase()
      ? REVIEWED_IMAGE_DESCRIPTIONS[filename] : undefined;
    // Empty captions cannot be repaired from a marketing filename; existing
    // human-reviewed originals may still supply their registered description.
    if (!reviewed && !caption?.trim()) continue;
    refs.push({
      id: `IMG${i + 1}`,
      filename,
      docId: doc.id,
      ...(typeof doc.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(doc.sha256) ? { sha256: doc.sha256.toLowerCase() } : {}),
      modelId,
      modelName,
      caption: reviewed ?? caption.trim(),
      purpose: reviewed ? '已核对原图的画面描述' : '本型号图库原图；原清单图注尚未逐图复核',
      visuallyReviewed: !!reviewed,
      width: Number(w),
      height: Number(h),
      source: '本地已下载知识库',
      url,
    });
  }
  return refs;
}
