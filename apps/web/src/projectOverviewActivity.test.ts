import { describe, expect, it } from "vite-plus/test";
import {
  activityHeatmap,
  activityIntervals,
  activitySummary,
  dailyActivity,
  hourlyActivity,
  localDateKey,
} from "./projectOverviewActivity";

const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute).getTime();
const iso = (time: number) => new Date(time).toISOString();

describe("project overview worker activity", () => {
  it("uses the latest turn for finished, running and unstarted workers", () => {
    const now = at(8, 12);
    const intervals = activityIntervals(
      [
        {
          key: "a",
          latestTurn: {
            requestedAt: iso(at(8, 9)),
            startedAt: iso(at(8, 9, 5)),
            completedAt: iso(at(8, 10)),
          },
        },
        {
          key: "b",
          latestTurn: { requestedAt: iso(at(8, 11)), startedAt: null, completedAt: null },
        },
        { key: "c", latestTurn: null },
      ],
      now,
    );
    expect(intervals).toEqual([{ workerKey: "a", start: at(8, 9, 5), end: at(8, 10) }]);
  });

  it("splits activity into local hours and clips it to the hour boundaries", () => {
    const hours = hourlyActivity(
      [{ workerKey: "a", start: at(8, 9, 30), end: at(8, 11, 15) }],
      at(8, 0),
    );
    expect(hours[8]).toBe(0);
    expect(hours[9]).toBe(30);
    expect(hours[10]).toBe(60);
    expect(hours[11]).toBe(15);
    expect(hours.reduce((sum, minutes) => sum + minutes, 0)).toBe(105);
  });

  it("splits an interval across midnight into both days", () => {
    const days = dailyActivity([{ workerKey: "a", start: at(7, 23), end: at(8, 1) }]);
    expect(days.get(localDateKey(at(7, 0)))).toBe(60);
    expect(days.get(localDateKey(at(8, 0)))).toBe(60);
  });

  it("lays out whole Monday-first weeks and leaves future days empty", () => {
    // 8 October 2026 is a Thursday.
    const now = at(8, 12);
    const days = new Map([
      [localDateKey(at(5, 0)), 120],
      [localDateKey(at(8, 0)), 30],
    ]);
    const grid = activityHeatmap(days, now, 2);
    expect(grid).toHaveLength(7);
    // Monday of the current week is row 0; Thursday (8 October) is row 3 and the current column is week 1.
    expect(grid[0]?.[1]?.key).toBe(localDateKey(at(5, 0)));
    expect(grid[3]?.[1]?.key).toBe(localDateKey(at(8, 0)));
    expect(grid[4]?.[1]).toBeNull();
    expect(grid[6]?.[1]).toBeNull();
    expect(grid[3]?.[1]?.level).toBe(1);
    expect(grid[0]?.[1]?.level).toBe(4);
  });

  it("summarizes workers, active days and minutes inside the heatmap window", () => {
    const now = at(8, 12);
    const intervals = [
      { workerKey: "a", start: at(5, 9), end: at(5, 10) },
      { workerKey: "b", start: at(8, 9), end: at(8, 9, 30) },
      { workerKey: "old", start: at(1, 9), end: at(1, 10) },
    ];
    const grid = activityHeatmap(dailyActivity(intervals), now, 1);
    expect(activitySummary(intervals, grid)).toEqual({
      workers: 2,
      activeDays: 2,
      totalMinutes: 90,
    });
  });
});
