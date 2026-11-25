export const POSITION_STEP = 1024;
export const MIN_POSITION_GAP = 1e-6;

export interface PositionResult {
  position: number;
  needsRebalance: boolean;
}

/**
 * Computes a float position for inserting a task between `prevPosition` and `nextPosition`.
 * - Empty column (both null): returns POSITION_STEP (1024).
 * - Append at end (nextPosition null): returns prevPosition + POSITION_STEP.
 * - Prepend at start (prevPosition null): returns nextPosition / 2 (or 0 - step if <= 0).
 * - Insert between two neighbors: midpoint, flagging rebalance when gap < MIN_POSITION_GAP.
 */
export function computeInsertPosition(
  prevPosition: number | null,
  nextPosition: number | null
): PositionResult {
  if (prevPosition === null && nextPosition === null) {
    return { position: POSITION_STEP, needsRebalance: false };
  }

  if (prevPosition !== null && nextPosition === null) {
    return { position: prevPosition + POSITION_STEP, needsRebalance: false };
  }

  if (prevPosition === null && nextPosition !== null) {
    if (nextPosition <= MIN_POSITION_GAP * 2) {
      return { position: nextPosition / 2, needsRebalance: true };
    }
    return { position: nextPosition / 2, needsRebalance: false };
  }

  // Both non-null
  const prev = prevPosition as number;
  const next = nextPosition as number;
  const gap = next - prev;
  const position = prev + gap / 2;
  const needsRebalance =
    gap < MIN_POSITION_GAP || position === prev || position === next;

  return { position, needsRebalance };
}

/**
 * Checks whether any adjacent tasks in a sorted list have a position gap below MIN_POSITION_GAP.
 */
export function columnNeedsRebalance(sortedPositions: readonly number[]): boolean {
  for (let i = 1; i < sortedPositions.length; i++) {
    const prev = sortedPositions[i - 1]!;
    const curr = sortedPositions[i]!;
    if (curr - prev < MIN_POSITION_GAP) {
      return true;
    }
  }
  return false;
}

/**
 * Computes 1024-step integer positions for a sorted list of items,
 * returning only the items whose position actually changed.
 */
export function computeRebalancedPositions<T extends { id: string; position: number }>(
  sortedItems: readonly T[]
): Array<{ id: string; position: number }> {
  const updates: Array<{ id: string; position: number }> = [];
  for (let i = 0; i < sortedItems.length; i++) {
    const targetPos = (i + 1) * POSITION_STEP;
    const item = sortedItems[i]!;
    if (item.position !== targetPos) {
      updates.push({ id: item.id, position: targetPos });
    }
  }
  return updates;
}
