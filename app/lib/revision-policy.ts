/** Gallery preference is not a request to replace the chosen gallery plan. */
export function requestsGalleryChange(instruction: string): boolean {
  const positive = instruction
    .replace(/(?:不要|不用|不必|无需|别)[^。；\n]{0,6}(?:更换|替换|修改|修正|纠正|调整|换|改|动)[^。；\n]{0,4}(?:图片|配图|图注|产品图)/g, '')
    .replace(/(?:不要|不用|不必|无需|别)(?:再)?(?:换|更换|删除|移除|增加)图(?=[，。；！\s]|$)/g, '');
  return /(?:更换|替换|修改|修正|纠正|调整|重排|删除|移除|增加|补充|重选|换|改)[^。；\n]{0,10}(?:图片|配图|图注|产品图)/.test(positive)
    || /(?:图片|配图|图注|产品图)[^。；\n]{0,10}(?:换成|改成|换掉|删掉|删除|调整|修改)/.test(positive)
    || /(?:换|更换|删除|移除|增加)图(?=[，。；！\s]|$)/.test(positive);
}
