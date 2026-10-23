/** Resolve catalog identities from trusted user turns, never assistant prose. */
export interface ProductTurn { role: 'user' | 'assistant'; content: string }
export interface ProductIdentity { id: string; name: string }
const key = (text: string) => text.normalize('NFKC').toLowerCase().replace(/huawei|华为/g, '').replace(/[\s()（）]/g, '');
const negative = /(?:不比较|不对比|别比较|不选|不考虑|不要|排除|不是|不想要|不问|别问|不看|别)(?:再|拿|用|把|选|考虑)?$/;
const familyMention = /matebook|mateview|matestation|pixlab|擎云|鼠标|打印机/i;
const clauseBefore = (text: string, index: number) => text.slice(0, index).split(/[，,。；;！？!?：:\n]/).at(-1) ?? '';
function occurrences(text: string, name: string): number[] {
  const indices: number[] = [];
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const before = text[at - 1] ?? '', after = text.slice(at + name.length);
    if (!/[a-z0-9]/.test(before) && (!/^[a-z0-9]/.test(after) || /^\d{1,4}(?:gb|tb|g|t)(?![a-z])/.test(after))) indices.push(at);
  }
  return indices;
}

export function resolvePriceProducts(catalog: readonly ProductIdentity[], current: string, history: readonly ProductTurn[] = []): {
  ids: string[]; needsClarification: boolean;
} {
  const byName = new Map<string, ProductIdentity[]>();
  for (const item of catalog) {
    const name = key(item.name);
    if (name.length < 4) continue;
    byName.set(name, [...(byName.get(name) ?? []), item]);
  }
  let active: string[] = [];
  let ambiguous = false;
  const turns = [...history.filter(turn => turn.role === 'user').slice(-12).map(turn => turn.content), current];
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const text = key(turnIndex === turns.length - 1 ? current : turns[turnIndex]);
    const positive: { id: string; at: number; length: number }[] = [];
    const excluded = new Set<string>();
    const mentions: { entries: ProductIdentity[]; at: number; length: number }[] = [];
    const stances = new Map<string, { negative: boolean; at: number; length: number }>();
    let named = false, duplicate = false;
    for (const [name, entries] of byName) for (const at of occurrences(text, name)) {
      mentions.push({ entries, at, length: name.length });
    }
    const specificMentions = mentions.filter(item => !mentions.some(other => other !== item && other.at <= item.at && other.at + other.length > item.at + item.length));
    for (const { entries, at, length } of specificMentions.sort((a, b) => a.at - b.at)) {
      named = true;
      if (entries.length !== 1) { duplicate = true; continue; }
      stances.set(entries[0].id, { negative: negative.test(clauseBefore(text, at)), at, length });
    }
    // Short names such as D14 only bind inside the active comparison;
    // they cannot discover a product or choose between generations globally.
    const scoped = new Map<string, string[]>();
    for (const id of active) {
      const item = catalog.find(item => item.id === id);
      const short = item && key(item.name).match(/^matebook(d\d{1,2})(?:20\d{2})?$/)?.[1];
      if (short) scoped.set(short, [...(scoped.get(short) ?? []), id]);
    }
    for (const [short, ids] of scoped) for (const at of occurrences(text, short)) {
      named = true;
      if (ids.length === 1) {
        if (at > (stances.get(ids[0])?.at ?? -1)) stances.set(ids[0], { negative: negative.test(clauseBefore(text, at)), at, length: short.length });
      } else duplicate = true;
    }
    for (const [id, stance] of stances) {
      if (stance.negative) excluded.add(id);
      else positive.push({ id, at: stance.at, length: stance.length });
    }
    if (duplicate) { active = []; ambiguous = true; }
    else if (positive.length) {
      const specific = positive.filter(item => !positive.some(other => other !== item && other.at <= item.at && other.at + other.length > item.at + item.length));
      active = [...new Set(specific.sort((a, b) => a.at - b.at).map(item => item.id))].filter(id => !excluded.has(id));
      ambiguous = false;
    }
    else if (excluded.size) { active = active.filter(id => !excluded.has(id)); ambiguous = !active.length; }
    else if (!named && familyMention.test(text)) { active = []; ambiguous = true; }
    else if (/(?:换成|改问|改为|改成|换为)(?:d\d+|pro|fold|gt\d+|xpro)/i.test(text)) { active = []; ambiguous = true; }
    if (turnIndex === turns.length - 1) {
      const plural = /两(?:款|台|个)|这(?:些|两)|各|分别|比较|对比|都/.test(text);
      if ((/两(?:款|台|个)/.test(text) && active.length !== 2) || (active.length > 1 && !plural && positive.length < 2) || active.length > 6) {
        return { ids: [], needsClarification: true };
      }
    }
  }
  return { ids: active, needsClarification: ambiguous };
}

export function isPriceQuestionOnly(text: string): boolean {
  return !/(?:写|创作|重写|改写|润色|生成|修改|编辑|删除)[^。！？\n]{0,30}(?:朋友圈|小红书|公众号|文案|稿件|正文|文章|标题|脚本|海报)|(?:标题|正文|文案|稿件)[^。！？\n]{0,8}(?:改成|改为|改写|修改|加|删|写|换)|改稿/.test(text)
    && !/适合|能不能|兼容|怎么选|如何选|选哪|推荐|主要区别|有何区别|做笔记|做设计|跑(?:软件|游戏|CAD)|哪些功能|有什么功能|性能如何|续航如何|是否支持/i.test(text);
}
