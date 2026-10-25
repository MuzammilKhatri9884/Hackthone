import test from "node:test";
import assert from "node:assert/strict";
import { summarizePerformance } from "../src/services/performance.js";
test("monthly performance uses actual attendance and excludes approved leave from expected days", () => {
  const result = summarizePerformance([
    { displayStatus: "present", checkIn: "2026-09-01T04:00:00Z", hours: 8 },
    {
      displayStatus: "late",
      checkIn: "2026-09-02T05:00:00Z",
      hours: 8,
      late: true,
    },
    { displayStatus: "absent", hours: 0 },
    { displayStatus: "on_leave", leaveFraction: 1, workCredit: 0, hours: 0 },
    { displayStatus: "half_day", checkIn: "2026-09-05T04:00:00Z", hours: 4 },
  ]);
  assert.equal(result.expectedDays, 4);
  assert.equal(result.presentDays, 3);
  assert.equal(result.absentDays, 1);
  assert.equal(result.leaveDays, 1);
  assert.equal(result.halfDays, 1);
  assert.equal(result.lateDays, 1);
  assert.equal(result.attendanceCredit, 2.5);
  assert.equal(result.attendanceRate, 62.5);
  assert.equal(result.punctualityRate, 66.67);
  assert.equal(result.hours, 20);
});
test("half-day leave preserves partial absence and does not invent attendance", () => {
  const missing = summarizePerformance([
    { displayStatus: "half_day", leaveFraction: 0.5, workCredit: 0, hours: 0 },
  ]);
  assert.equal(missing.presentDays, 0);
  assert.equal(missing.absentDays, 0.5);
  assert.equal(missing.attendanceRate, 0);
  const worked = summarizePerformance([
    {
      displayStatus: "half_day",
      leaveFraction: 0.5,
      workCredit: 0.5,
      checkIn: "2026-09-15T04:00:00Z",
      hours: 4,
    },
  ]);
  assert.equal(worked.presentDays, 1);
  assert.equal(worked.absentDays, 0);
  assert.equal(worked.attendanceRate, 100);
  assert.equal(summarizePerformance([]).attendanceRate, 0);
});
