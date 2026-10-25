import {
  Employee,
  Attendance,
  Leave,
  Payroll,
  Department,
  Designation,
  LeaveType,
  Audit,
  User,
} from "../models/index.js";
import { attendanceRows } from "./attendance.js";
import {
  monthlyPerformance,
  wasPresent,
  absenceCredit,
} from "./performance.js";
import { settings } from "./common.js";
import { localParts, datesBetween, money, leaveUnits } from "./rules.js";
export async function balances(id, year) {
  const types = await LeaveType.find().lean();
  const leaves = await Leave.find({
    employee_id: id,
    year,
    status: { $in: ["approved", "pending"] },
  }).lean();
  return types.map((t) => {
    const own = leaves.filter((l) => String(l.type) === String(t._id));
    const used = own
        .filter((l) => l.status === "approved")
        .reduce((n, l) => n + leaveUnits(l), 0),
      reserved = own
        .filter((l) => l.status === "pending")
        .reduce((n, l) => n + leaveUnits(l), 0);
    return {
      ...t,
      used,
      reserved,
      remaining: t.unpaid ? null : Math.max(0, t.quota - used - reserved),
    };
  });
}
export async function analytics(user, filters = {}) {
  const s = await settings(),
    today = localParts(new Date(), s.timezone).date;
  const start = filters.start || today.slice(0, 7) + "-01",
    end = filters.end || today;
  datesBetween(start, end);
  const filter =
    user.role === "Employee" ? { _id: user.employee_id || null } : {};
  if (filters.department && user.role !== "Employee")
    filter.department = filters.department;
  const employees = await Employee.find(filter).lean(),
    ids = employees.map((e) => e._id);
  const rows = await attendanceRows(employees, start, end);
  const [leaves, runs, depts, designations] = await Promise.all([
    Leave.find({
      employee_id: { $in: ids },
      start: { $lte: end },
      end: { $gte: start },
    })
      .populate("type")
      .lean(),
    Payroll.find({
      month: { $gte: start.slice(0, 7), $lte: end.slice(0, 7) },
      ...(user.role === "Employee" ? { status: "finalized" } : {}),
    }).lean(),
    Department.find().lean(),
    Designation.find().lean(),
  ]);
  const current = employees.filter(
    (e) => e.joinDate <= end && (!e.exitDate || e.exitDate > end),
  );
  const atStart = employees.filter(
    (e) => e.joinDate <= start && (!e.exitDate || e.exitDate > start),
  );
  const exits = employees.filter(
    (e) => e.exitDate && e.exitDate >= start && e.exitDate <= end,
  ).length;
  const dayRows =
    start <= today && end >= today
      ? rows.filter((a) => a.date === today)
      : await attendanceRows(employees, today, today);
  const tally = (status) =>
    rows.filter((a) => a.displayStatus === status).length;
  const onLeave = rows.reduce(
      (n, a) =>
        n + (a.leaveFraction ?? (a.displayStatus === "on_leave" ? 1 : 0)),
      0,
    ),
    expected = rows.length - onLeave,
    credit = rows.reduce(
      (n, a) =>
        n +
        (a.workCredit ??
          (["present", "late", "missing_checkout"].includes(a.displayStatus)
            ? 1
            : a.displayStatus === "half_day"
              ? 0.5
              : 0)),
      0,
    );
  const slips = runs.flatMap((r) =>
    r.slips
      .filter((p) => ids.some((id) => String(id) === String(p.employee_id)))
      .map((p) => ({ ...p, month: r.month })),
  );
  const trend = datesBetween(start, end).map((date) => ({
    date: date.slice(5),
    present: rows.filter(
      (a) =>
        a.date === date &&
        ["present", "late", "missing_checkout", "half_day"].includes(
          a.displayStatus,
        ),
    ).length,
    absent: rows.filter((a) => a.date === date && a.displayStatus === "absent")
      .length,
    onLeave: rows.filter(
      (a) =>
        a.date === date &&
        (a.displayStatus === "on_leave" || a.leaveFraction > 0),
    ).length,
  }));
  const departments = depts.map((d) => {
    const members = employees.filter(
      (e) => String(e.department) === String(d._id),
    );
    const own = rows.filter((a) =>
      members.some((e) => String(e._id) === String(a.employee_id._id)),
    );
    const costs = slips.filter((p) => String(p.department) === String(d._id));
    return {
      name: d.name,
      headcount: current.filter((e) => String(e.department) === String(d._id))
        .length,
      absent: own.filter((a) => a.displayStatus === "absent").length,
      absenteeism: own.length
        ? money(
            (own.filter((a) => a.displayStatus === "absent").length /
              own.length) *
              100,
          )
        : 0,
      payroll: money(costs.reduce((n, p) => n + p.gross, 0)),
      averageSalary: members.length
        ? money(
            members.reduce((n, e) => n + e.basicSalary * 1.5, 0) /
              members.length,
          )
        : 0,
    };
  });
  const lateComers = employees
    .map((e) => ({
      name: e.name,
      count: rows.filter(
        (a) => String(a.employee_id._id) === String(e._id) && a.late,
      ).length,
    }))
    .filter((e) => e.count)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const aggregation = await Attendance.aggregate([
    { $match: { employee_id: { $in: ids }, date: { $gte: start, $lte: end } } },
    {
      $group: { _id: "$status", count: { $sum: 1 }, hours: { $sum: "$hours" } },
    },
  ]);
  const leaveByType = await LeaveType.find().lean();
  const hrEmployeeIds = (
    await User.find({ role: "HR", employee_id: { $in: ids } }).distinct(
      "employee_id",
    )
  ).map(String);
  const pending = leaves.filter(
    (l) =>
      l.status === "pending" &&
      (user.role === "Employee" ||
        ((l.approverRole ||
          (l.requesterRole === "HR" ||
          hrEmployeeIds.includes(String(l.employee_id))
            ? "Admin"
            : "HR")) === user.role &&
          String(l.employee_id) !== String(user.employee_id))),
  ).length;
  const monday = new Date(today + "T12:00:00Z");
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const weekly = await Attendance.aggregate([
    {
      $match: {
        employee_id: { $in: ids },
        date: { $gte: monday.toISOString().slice(0, 10), $lte: today },
      },
    },
    { $group: { _id: null, hours: { $sum: "$hours" } } },
  ]);
  const yearStart = end.slice(0, 4) + "-01-01";
  const performance = await monthlyPerformance(
    employees,
    filters.month || end.slice(0, 7),
  );
  const yearExits = employees.filter(
    (e) => e.exitDate && e.exitDate >= yearStart && e.exitDate <= end,
  ).length;
  const yearStartCount = employees.filter(
    (e) => e.joinDate <= yearStart && (!e.exitDate || e.exitDate > yearStart),
  ).length;
  return {
    start,
    end,
    today,
    headcount: current.length,
    present: dayRows.filter(wasPresent).length,
    absentToday: dayRows.filter((a) => absenceCredit(a) > 0).length,
    monthlyPerformance: performance,
    onLeave: dayRows.filter(
      (a) => a.displayStatus === "on_leave" || a.leaveFraction > 0,
    ).length,
    late: dayRows.filter((a) => a.late).length,
    pending,
    attrition: money(
      (exits / ((atStart.length + current.length) / 2 || 1)) * 100,
    ),
    payrollCost: money(slips.reduce((n, p) => n + p.gross, 0)),
    netPayroll: money(slips.reduce((n, p) => n + p.net, 0)),
    averageSalary: current.length
      ? money(
          current.reduce((n, e) => n + e.basicSalary * 1.5, 0) / current.length,
        )
      : 0,
    attendanceRate: expected ? money((credit / expected) * 100) : 0,
    latePercent:
      tally("present") + tally("late")
        ? money((tally("late") / (tally("present") + tally("late"))) * 100)
        : 0,
    absent: tally("absent"),
    hours: money(rows.reduce((n, a) => n + a.hours, 0)),
    weekHours: money(weekly[0]?.hours || 0),
    attritionYtd: money(
      (yearExits / ((yearStartCount + current.length) / 2 || 1)) * 100,
    ),
    lateCount: rows.filter((a) => a.late).length,
    trend,
    departments: user.role === "Employee" ? [] : departments,
    designations:
      user.role === "Employee"
        ? []
        : designations.map((d) => {
            const members = current.filter(
              (e) => String(e.designation) === String(d._id),
            );
            return {
              name: d.name,
              headcount: members.length,
              averageSalary: members.length
                ? money(
                    members.reduce((n, e) => n + e.basicSalary * 1.5, 0) /
                      members.length,
                  )
                : 0,
            };
          }),
    lateComers: user.role === "Employee" ? [] : lateComers,
    leaveByType: leaveByType.map((t) => ({
      name: t.name,
      days: leaves
        .filter(
          (l) =>
            String(l.type?._id) === String(t._id) && l.status === "approved",
        )
        .reduce(
          (n, l) =>
            n +
            l.days.filter((d) => d >= start && d <= end).length *
              (l.duration === "half_day" ? 0.5 : 1),
          0,
        ),
      quota: t.quota,
    })),
    gender:
      user.role === "Employee"
        ? []
        : ["Female", "Male", "Other", "Prefer not to say"].map((name) => ({
            name,
            count: current.filter((e) => e.gender === name).length,
          })),
    tenure:
      user.role === "Employee"
        ? []
        : current.map((e) => ({
            name: e.name,
            months: Math.max(
              0,
              Math.floor((new Date(end) - new Date(e.joinDate)) / 2629800000),
            ),
          })),
    aggregation,
    balance: user.employee_id
      ? await balances(user.employee_id, Number(end.slice(0, 4)))
      : [],
    lastPayslip:
      [...slips].sort((a, b) => b.month.localeCompare(a.month))[0] || null,
    audit:
      user.role === "Admin"
        ? await Audit.find().sort({ createdAt: -1 }).limit(5).lean()
        : [],
  };
}
