import { Holiday } from "../models/index.js";
import { attendanceRows } from "./attendance.js";
import { settings } from "./common.js";
import { assert, localParts, money } from "./rules.js";

export const workCredit = (row) =>
  row.workCredit ??
  (["present", "late", "missing_checkout"].includes(row.displayStatus)
    ? 1
    : row.displayStatus === "half_day"
      ? 0.5
      : 0);
export const leaveCredit = (row) =>
  row.leaveFraction ?? (row.displayStatus === "on_leave" ? 1 : 0);
export const absenceCredit = (row) =>
  row.displayStatus === "absent"
    ? 1
    : row.leaveFraction === 0.5 && !row.checkIn
      ? 0.5
      : 0;
export const wasPresent = (row) =>
  Boolean(row.checkIn) ||
  (["present", "late", "missing_checkout", "half_day"].includes(
    row.displayStatus,
  ) &&
    !row.leaveFraction);

export function summarizePerformance(rows) {
  const expectedDays = money(rows.reduce((n, r) => n + 1 - leaveCredit(r), 0));
  const presentDays = rows.filter(wasPresent).length;
  const attendanceCredit = money(rows.reduce((n, r) => n + workCredit(r), 0));
  const lateDays = rows.filter((r) => wasPresent(r) && r.late).length;
  return {
    expectedDays,
    presentDays,
    attendanceCredit,
    absentDays: money(rows.reduce((n, r) => n + absenceCredit(r), 0)),
    leaveDays: money(rows.reduce((n, r) => n + leaveCredit(r), 0)),
    halfDays: rows.filter((r) => r.displayStatus === "half_day").length,
    lateDays,
    onTimeDays: presentDays - lateDays,
    hours: money(rows.reduce((n, r) => n + (r.hours || 0), 0)),
    attendanceRate: expectedDays
      ? money((attendanceCredit / expectedDays) * 100)
      : 0,
    punctualityRate: presentDays
      ? money(((presentDays - lateDays) / presentDays) * 100)
      : 0,
  };
}

export async function monthlyPerformance(
  employees,
  month,
  { rows: preloadedRows, rules: preloadedRules } = {},
) {
  assert(
    typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month),
    422,
    "Choose a valid performance month (YYYY-MM).",
  );
  const s = preloadedRules || (await settings()),
    today = localParts(new Date(), s.timezone).date;
  const start = month + "-01",
    end = new Date(
      Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
    )
      .toISOString()
      .slice(0, 10);
  const [rows, todayRows, holiday] = await Promise.all([
    preloadedRows || attendanceRows(employees, start, end, s),
    preloadedRows && today >= start && today <= end
      ? preloadedRows.filter((row) => row.date === today)
      : attendanceRows(employees, today, today, s),
    Holiday.exists({ date: today }),
  ]);
  const grouped = new Map();
  for (const row of rows) {
    const id = String(row.employee_id._id);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(row);
  }
  const items = employees
    .filter((e) => e.joinDate <= end && (!e.exitDate || e.exitDate >= start))
    .map((e) => ({
      employee_id: e._id,
      name: e.name,
      code: e.code,
      ...summarizePerformance(grouped.get(String(e._id)) || []),
    }));
  return {
    month,
    start,
    end,
    asOf: today < end ? today : end,
    daily: {
      date: today,
      workingDay:
        !s.weekends.includes(new Date(today + "T12:00:00Z").getUTCDay()) &&
        !holiday,
      present: todayRows.filter(wasPresent).length,
      absent: todayRows.filter((r) => absenceCredit(r) > 0).length,
      onLeave: todayRows.filter((r) => leaveCredit(r) > 0).length,
      late: todayRows.filter((r) => wasPresent(r) && r.late).length,
    },
    summary: summarizePerformance(rows),
    items,
  };
}
