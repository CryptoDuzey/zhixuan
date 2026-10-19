import { KnowledgeDocumentError, readKnowledgeDocument } from '../../../../lib/retrieval.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const headers = {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'content-type': 'text/plain; charset=utf-8',
  };
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => key !== 'id') || params.getAll('id').length !== 1) {
      throw new KnowledgeDocumentError(400, '请提供唯一的资料编号。');
    }
    return new Response(await readKnowledgeDocument(params.get('id')!), { headers });
  } catch (error) {
    return new Response(error instanceof KnowledgeDocumentError ? error.message : '资料暂时无法读取。',
      { status: error instanceof KnowledgeDocumentError ? error.status : 503, headers });
  }
}
