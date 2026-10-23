/** Explicit body limits only; titles, tags and general advice are not a limit. */
export function explicitBodyMaximum(instruction: string): number | undefined {
  const clauses = instruction.split(/[。；;\n]/);
  let limit: number | undefined;
  for (const clause of clauses) {
    if (/(?:不要|不用|不必|无需|别).{0,8}(?:压缩|缩到|控制|限制)/.test(clause)) continue;
    const match = clause.match(/正文[^\d。；\n]{0,20}(\d{1,4})\s*字(?:以|之)?内/)
      ?? clause.match(/正文[^\d。；\n]{0,20}(?:不超过|最多|至多)\s*(\d{1,4})\s*字/);
    if (match && Number(match[1]) > 0) limit = Number(match[1]);
  }
  return limit;
}

export function explicitBodyRange(instruction: string): { min: number; max: number } | undefined {
  const match = instruction.match(/正文[^\d。；\n]{0,12}(\d{1,4})\s*(?:到|至|—|–|-|~|～)\s*(\d{1,4})\s*字/);
  if (!match) return;
  const min = Number(match[1]), max = Number(match[2]);
  if (min > 0 && max >= min) return { min, max };
}
