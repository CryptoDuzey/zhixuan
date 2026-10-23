import type { CheckReport, Draft } from './check.ts';
import { hasCompleteClaimReview, isBlockingIssue, isPublishableReport } from './check.ts';

/** The saved conversation and live response describe the same usable result. */
export function draftMessage(draft: Draft, report?: CheckReport): string {
  if (!report || report.draftVersion !== draft.version) return '草稿放好了，还需要稍作整理。';
  const blocks = report.issues.filter(isBlockingIssue).length;
  if (blocks) return `这版还有 ${blocks} 处需要调整，点“内容建议”查看。`;
  if (!hasCompleteClaimReview(report, draft)) return '草稿放好了，还需要稍作整理。';
  if (!isPublishableReport(report, draft)) return '这版还有需要调整的地方，暂时不能导出。';
  if (report.issues.length) return '写好了，有几处细节可以留意，点“内容建议”查看。';
  return '写好了，看看这个版本。';
}

/** Translate only our exact old status templates; never rewrite user/model prose. */
export function restoredDraftMessage(text: string): string {
  if (/^第 \d+ 版已核验，\d+ 项必须处理，\d+ 项建议留意。$/.test(text)) {
    const counts = text.match(/版已核验，(\d+) 项必须处理，(\d+) 项建议留意/)!;
    return Number(counts[1]) ? `这版还有 ${Number(counts[1])} 处需要调整，点“内容建议”查看。`
      : Number(counts[2]) ? '写好了，有几处细节可以留意，点“内容建议”查看。' : '写好了，看看这个版本。';
  }
  if (/^已保留第 \d+ 版，当前版本尚未完成核验。$/.test(text)) return '草稿放好了，还需要稍作整理。';
  return text;
}
