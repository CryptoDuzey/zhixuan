/** Last explicit price preference wins; a budget alone is not a price request. */
export function priceIntent(text: string): boolean | undefined {
  const topic = /价格|标价|参考价|定价|多少钱|价钱|报价|售价|到手价|优惠|补贴|折扣|促销|历史价|怎么卖|价位|什么价|多贵|how much|\bprice\b/i;
  const refusal = /(?:不要|不用|不必|无需|不需要|不关心|先别|先不|暂不|别|不|勿)(?:讨论|谈论|提供|给出|写入|加入|提及|写|提|问|看|谈|考虑|关注|关心|报|需要|要|再|现在|先|具体|任何|的|\s)*(?:价格|标价|参考价|定价|多少钱|报价|价钱|售价|到手价|优惠|补贴|促销|折扣|历史价|价位)|(?:价格|标价|参考价|定价|报价|价钱|优惠|补贴|促销)(?:和优惠|与优惠|先|暂时|现在|就|\s)*(?:不|别|无需|不用|不必)(?:讨论|写入|提及|写|提|谈|看|问|报|考虑)/;
  let wanted: boolean | undefined;
  for (const clause of text.split(/[，,。！？!?；;\n]/)) {
    // Preserve the negative verb across a noun list, not across another request.
    const scoped = clause.replace(/((?:不要|不用|不必|无需|先别|先不|暂不|别|不|勿)(?:写入|加入|提及|写|提|讨论|谈论))(?:(?:(?!但|不过|请|告诉|现在|问|给)[^、和与及，,。！？!?；;\n]){1,16}(?:、|和|与|以及|及)){1,4}(?=价格|标价|参考价|定价|多少钱|报价|价钱|售价|到手价|优惠|补贴|促销|折扣|历史价|价位)/g, '$1');
    if (topic.test(clause)) wanted = !refusal.test(scoped);
  }
  return wanted;
}

export const asksPrice = (text: string): boolean => priceIntent(text) === true;
