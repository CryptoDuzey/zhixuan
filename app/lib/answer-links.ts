export type AnswerPart = { text: string; href?: string };
export function answerParts(text: string): AnswerPart[] {
  const parts: AnswerPart[] = []; let offset = 0;
  const pattern = /\[([^\]\r\n]{1,120})\]\((https?:\/\/[^\s<>"）)]+)\)|https?:\/\/[^\s<>"）)\]]+/g;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > offset) parts.push({ text: text.slice(offset, match.index) });
    const raw = match[2] ?? match[0];
    const href = raw.replace(/[。，,；;！!？?]+$/, '');
    let safe = false;
    try { const url = new URL(href); safe = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { /* Render invalid addresses as text. */ }
    parts.push(safe ? { text: match[1] ?? href, href } : { text: match[0] });
    if (safe && !match[2] && raw.length > href.length) parts.push({ text: raw.slice(href.length) });
    offset = match.index! + match[0].length;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts;
}
