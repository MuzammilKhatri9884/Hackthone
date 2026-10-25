export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const assert = (condition, status, message, details) => {
  if (!condition) throw new HttpError(status, message, details);
};
export const isoDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
export function datesBetween(start, end) {
  assert(
    isoDate(start) && isoDate(end) && start <= end,
    422,
    "Use a valid ISO date range.",
  );
  const days = [];
  for (
    let d = new Date(`${start}T00:00:00Z`);
    d <= new Date(`${end}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    days.push(d.toISOString().slice(0, 10));
    assert(days.length <= 366, 422, "Date range cannot exceed one year.");
  }
  return days;
}
export const workingDates = (start, end, settings, holidays = []) =>
  datesBetween(start, end).filter(
    (d) =>
      !settings.weekends.includes(new Date(`${d}T12:00:00Z`).getUTCDay()) &&
      !holidays.includes(d),
  );
export function localParts(date, timezone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((v) => [v.type, v.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute) + Number(p.second) / 60,
  };
}
export function attendanceResult(checkIn, checkOut, rules) {
  assert(
    checkIn &&
      !isNaN(Date.parse(checkIn)) &&
      (!checkOut || !isNaN(Date.parse(checkOut))),
    422,
    "Use valid check-in and check-out timestamps.",
  );
  const [h, m] = rules.officeStart.split(":").map(Number);
  const late =
    localParts(new Date(checkIn), rules.timezone).minutes >
    h * 60 + m + rules.graceMinutes;
  const hours = checkOut
    ? (new Date(checkOut) - new Date(checkIn)) / 3600000
    : 0;
  assert(
    hours >= 0 && hours <= 24,
    422,
    "Check-out must follow check-in within 24 hours.",
  );
  return {
    hours: Math.round(hours * 100) / 100,
    late,
    status: !checkOut
      ? "missing_checkout"
      : hours < rules.halfDayHours
        ? "half_day"
        : late
          ? "late"
          : "present",
  };
}
export function annualTax(income) {
  if (income <= 600000) return 0;
  if (income <= 1200000) return (income - 600000) * 0.05;
  if (income <= 2400000) return 30000 + (income - 1200000) * 0.15;
  if (income <= 3600000) return 210000 + (income - 2400000) * 0.25;
  return 510000 + (income - 3600000) * 0.35;
}
export const money = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const leaveUnits = (leave) =>
  leave.totalDays ??
  leave.days.length * (leave.duration === "half_day" ? 0.5 : 1);
export function salarySlip(employee, working, attendance, leaves) {
  const eligible = working.filter(
    (d) =>
      d >= employee.joinDate && (!employee.exitDate || d <= employee.exitDate),
  );
  let absent = 0,
    unpaid = 0,
    halfDays = 0;
  for (const d of eligible) {
    const leave = leaves.find((l) => l.days.includes(d));
    const a = attendance.find((r) => r.date === d);
    if (leave) {
      const fraction = leave.duration === "half_day" ? 0.5 : 1;
      if (leave.unpaid) unpaid += fraction;
      if (fraction === 0.5 && (!a || a.status === "absent")) absent += 0.5;
    } else if (!a || a.status === "absent") absent++;
    else if (a.status === "half_day") halfDays++;
  }
  const basic = employee.basicSalary,
    fullGross = basic * 1.5,
    perDay = working.length ? fullGross / working.length : 0,
    gross = money(perDay * eligible.length),
    deduction = money(perDay * (absent + unpaid + halfDays * 0.5)),
    tax = money(annualTax(gross * 12) / 12);
  return {
    employee_id: employee._id,
    name: employee.name,
    code: employee.code,
    department: employee.department,
    basic,
    hra: money(basic * 0.4),
    medical: money(basic * 0.1),
    gross,
    workingDays: working.length,
    eligibleDays: eligible.length,
    absent,
    unpaid,
    halfDays,
    deduction,
    tax,
    net: money(Math.max(0, gross - deduction - tax)),
  };
}
