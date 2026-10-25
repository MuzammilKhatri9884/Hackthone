import {
  Attendance,
  Leave,
  Holiday,
  Employee,
  Payroll,
} from "../models/index.js";
import { settings } from "./common.js";
import { assert, datesBetween, localParts, attendanceResult } from "./rules.js";
export async function assertUnlocked(date) {
  assert(
    !(await Payroll.exists({ month: date.slice(0, 7), status: "finalized" })),
    409,
    "This month is finalized. Its attendance and leave records are locked.",
  );
}
export async function assertWorkday(id, date, rules) {
  const e = await Employee.findById(id);
  assert(
    e && date >= e.joinDate && (!e.exitDate || date <= e.exitDate),
    422,
    "Date is outside your employment period.",
  );
  assert(
    !rules.weekends.includes(new Date(date + "T12:00:00Z").getUTCDay()) &&
      !(await Holiday.exists({ date })),
    422,
    "Attendance is available on working days only.",
  );
  assert(
    !(await Leave.exists({
      employee_id: id,
      status: "approved",
      days: date,
      duration: { $ne: "half_day" },
    })),
    422,
    "You have approved leave on this date.",
  );
}
export async function attendanceRows(employees, start, end) {
  const rules = await settings();
  const today = localParts(new Date(), rules.timezone).date;
  const ids = employees.map((e) => e._id);
  const [records, leaves, holidays] = await Promise.all([
    Attendance.find({
      employee_id: { $in: ids },
      date: { $gte: start, $lte: end },
    }).lean(),
    Leave.find({
      employee_id: { $in: ids },
      status: "approved",
      start: { $lte: end },
      end: { $gte: start },
    }).lean(),
    Holiday.find({ date: { $gte: start, $lte: end } }).lean(),
  ]);
  const result = [];
  const range = datesBetween(start, end);
  const recordMap = new Map(
    records.map((a) => [`${a.employee_id}:${a.date}`, a]),
  );
  const leaveDays = new Map(
    leaves.flatMap((l) => l.days.map((d) => [`${l.employee_id}:${d}`, l])),
  );
  const holidayDays = new Set(holidays.map((h) => h.date));
  for (const e of employees)
    for (const date of range) {
      if (
        date > today ||
        date < e.joinDate ||
        (e.exitDate && date > e.exitDate)
      )
        continue;
      const key = `${e._id}:${date}`;
      const leave = leaveDays.get(key);
      const halfLeave = leave?.duration === "half_day";
      const found = recordMap.get(key);
      if (found && !leave) {
        result.push({
          ...found,
          employee_id: {
            _id: e._id,
            name: e.name,
            code: e.code,
            department: e.department,
          },
          displayStatus: found.checkOut
            ? found.status
            : date === today
              ? found.late
                ? "late"
                : "present"
              : "missing_checkout",
        });
        continue;
      }
      if (
        rules.weekends.includes(new Date(date + "T12:00:00Z").getUTCDay()) ||
        holidayDays.has(date)
      )
        if (!leave) continue;
      result.push({
        employee_id: {
          _id: e._id,
          name: e.name,
          code: e.code,
          department: e.department,
        },
        date,
        status: halfLeave ? "half_day" : leave ? "on_leave" : "absent",
        displayStatus: halfLeave ? "half_day" : leave ? "on_leave" : "absent",
        hours: halfLeave ? found?.hours || 0 : 0,
        late: halfLeave ? Boolean(found?.late) : false,
        ...(leave
          ? {
              leaveType: leave.typeName,
              leaveFraction: halfLeave ? 0.5 : 1,
              workCredit: halfLeave && found?.checkIn ? 0.5 : 0,
            }
          : {}),
        ...(halfLeave && found
          ? { checkIn: found.checkIn, checkOut: found.checkOut }
          : {}),
      });
    }
  return result.sort((a, b) => b.date.localeCompare(a.date));
}
export async function markCheckin(id, extra = {}) {
  const rules = await settings();
  const now = new Date(),
    date = localParts(now, rules.timezone).date;
  await assertUnlocked(date);
  assert(
    !(await Attendance.exists({ employee_id: id, date })),
    409,
    "You have already checked in today.",
  );
  await assertWorkday(id, date, rules);
  return Attendance.create({
    employee_id: id,
    date,
    checkIn: now,
    ...attendanceResult(now, null, rules),
    rules,
    ...extra,
  });
}
