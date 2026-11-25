import { describe, expect, it } from "vitest";
import {
  MIN_POSITION_GAP,
  POSITION_STEP,
  columnNeedsRebalance,
  computeInsertPosition,
  computeRebalancedPositions,
} from "../src/position.js";

describe("position calculation & rebalancing", () => {
  it("returns 1024 for an empty column", () => {
    expect(computeInsertPosition(null, null)).toEqual({
      position: POSITION_STEP,
      needsRebalance: false,
    });
  });

  it("appends using last + 1024", () => {
    expect(computeInsertPosition(2048, null)).toEqual({
      position: 3072,
      needsRebalance: false,
    });
  });

  it("prepends using midpoint to 0", () => {
    expect(computeInsertPosition(null, 1024)).toEqual({
      position: 512,
      needsRebalance: false,
    });
  });

  it("computes midpoint between two neighbors", () => {
    expect(computeInsertPosition(1024, 2048)).toEqual({
      position: 1536,
      needsRebalance: false,
    });
  });

  it("flags rebalance when gap drops below 1e-6", () => {
    const res = computeInsertPosition(1024, 1024 + 5e-7);
    expect(res.needsRebalance).toBe(true);
    expect(columnNeedsRebalance([1024, 1024 + 5e-7, 2048])).toBe(true);
  });

  it("does not flag rebalance when gaps are >= 1e-6", () => {
    expect(columnNeedsRebalance([1024, 1024 + MIN_POSITION_GAP * 2, 2048])).toBe(false);
  });

  it("rebalances column to 1024-step integers and reports only changed tasks", () => {
    const updates = computeRebalancedPositions([
      { id: "a", position: 1024 },
      { id: "b", position: 1024.0000001 },
      { id: "c", position: 2048 },
      { id: "d", position: 4096 },
    ]);
    expect(updates).toEqual([
      { id: "b", position: 2048 },
      { id: "c", position: 3072 },
    ]);
  });
});
