import { ChatHistoryQueryError, listChats, parseChatHistoryQuery } from '../../../lib/chat-history.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Local saved history only. GET creates no sessions and accepts no file paths.
 * 200: {items: [{id, kind:'agent'|'consult', title, updatedAt, busy}], nextCursor?}
 * kind omitted = both; limit default 40 / maximum 200. Pass nextCursor back as
 * cursor with the same kind filter. No cursor means refresh from the newest.
 * 400 invalid query/cursor; 500 directory failure, with no filesystem details.
 */
export async function GET(request: Request): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const query = parseChatHistoryQuery(new URL(request.url).searchParams);
    return Response.json(await listChats(query), { headers });
  } catch (error) {
    if (error instanceof ChatHistoryQueryError) return Response.json({ error: error.message }, { status: 400, headers });
    return Response.json({ error: '暂时无法读取历史对话，请稍后重试。' }, { status: 500, headers });
  }
}
