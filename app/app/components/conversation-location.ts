import { validStudioId } from './frontend-session.ts';

/** An explicit page conversation always wins over a different tab's recent id. */
export function conversationId(search: string, recent: unknown): string | undefined {
  const query = new URLSearchParams(search);
  if (query.has('chat')) {
    const ids = query.getAll('chat');
    return ids.length === 1 && validStudioId(ids[0]) ? ids[0] : undefined;
  }
  return validStudioId(recent) ? recent : undefined;
}

type PageLocation = Pick<Location, 'pathname' | 'search' | 'hash'>;
type PageHistory = Pick<History, 'state' | 'replaceState'>;

/** Replace only the opaque chat id, preserving router state and unrelated URLs. */
export function pinConversation(id: string, location: PageLocation, history: PageHistory): boolean {
  if (!validStudioId(id)) return false;
  try {
    const query = new URLSearchParams(location.search);
    query.set('chat', id);
    history.replaceState(history.state, '', `${location.pathname}?${query}${location.hash}`);
    return true;
  } catch { return false; }
}
