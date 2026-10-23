export const WORKSPACE_DIVIDER = 12;
type WorkspaceMedia = { readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void };

/** Leaving the two-column layout cancels capture even without another move. */
export function watchWorkspaceBreakpoint(media: WorkspaceMedia, cancel: () => void): () => void {
  const changed = () => { if (media.matches) cancel(); };
  media.addEventListener('change', changed);
  changed();
  return () => { media.removeEventListener('change', changed); cancel(); };
}
/** Match the existing two fr tracks, their minima and the 860px breakpoint. */
export function workspacePointerSplit(width: number, pointer: number, grab: number): number | undefined {
  if (![width, pointer, grab].every(Number.isFinite) || width <= 860 || grab < 0 || grab > WORKSPACE_DIVIDER) return;
  const available = width - WORKSPACE_DIVIDER;
  const low = Math.max(280, available * 0.28);
  const high = Math.min(available - 360, available * 0.64);
  return 100 * Math.max(low, Math.min(high, pointer - grab)) / available;
}
