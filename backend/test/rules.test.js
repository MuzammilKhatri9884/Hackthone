import test from "node:test";
import assert from "node:assert/strict";
import {
  workingDates,
  attendanceResult,
  annualTax,
  salarySlip,
  isoDate,
  localParts,
} from "../src/services/rules.js";
const rules = {
  weekends: [0, 6],
  officeStart: "09:00",
  graceMinutes: 15,
  halfDayHours: 5,
  timezone: "Asia/Karachi",
};
test("dates reject normalized invalid calendar dates", () => {
  assert.equal(isoDate("2026-02-30"), false);
  assert.equal(isoDate("2026-10-25"), true);
  assert.equal(isoDate("25/10/2026"), false);
});
test("working days exclude weekends and public holidays", () =>
  assert.deepEqual(
    workingDates("2026-10-23", "2026-10-28", rules, ["2026-10-26"]),
    ["2026-10-23", "2026-10-27", "2026-10-28"],
  ));
test("lateness boundary is strictly after 09:15, and under five hours is half day", () => {
  assert.equal(
    attendanceResult("2026-10-26T04:15:00Z", "2026-10-26T09:15:00Z", rules)
      .status,
    "present",
  );
  assert.equal(
    attendanceResult("2026-10-26T04:16:00Z", "2026-10-26T10:00:00Z", rules)
      .status,
    "late",
  );
  assert.equal(
    attendanceResult("2026-10-26T04:00:00Z", "2026-10-26T08:59:59Z", rules)
      .status,
    "half_day",
  );
  assert.equal(
    attendanceResult("2026-10-26T04:00:00Z", null, rules).status,
    "missing_checkout",
  );
});
test("timestamps use company timezone and reject negative duration", () => {
  assert.equal(
    localParts(new Date("2026-10-25T20:00:00Z"), rules.timezone).date,
    "2026-10-26",
  );
  assert.throws(() =>
    attendanceResult("2026-10-26T10:00:00Z", "2026-10-26T09:00:00Z", rules),
  );
});
test("illustrative tax slabs are continuous at every boundary", () => {
  for (const [income, tax] of [
    [600000, 0],
    [1200000, 30000],
    [2400000, 210000],
    [3600000, 510000],
    [4000000, 650000],
  ])
    assert.equal(annualTax(income), tax);
});
test("joiner tax annualizes the actual prorated gross", () => {
  const working = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"];
  const slip = salarySlip(
    {
      _id: "e",
      name: "Joiner",
      code: "E1",
      department: "d",
      basicSalary: 100000,
      joinDate: "2026-10-28",
    },
    working,
    [
      { date: "2026-10-28", status: "present" },
      { date: "2026-10-29", status: "present" },
    ],
    [],
  );
  assert.equal(slip.gross, 75000);
  assert.equal(slip.tax, 1250);
  assert.equal(slip.net, 73750);
});
test("payroll prorates and deducts absent, unpaid, half day without double counting", () => {
  const employee = {
    _id: "e",
    name: "Test",
    code: "E1",
    department: "d",
    basicSalary: 20000,
    joinDate: "2026-10-27",
  };
  const slip = salarySlip(
    employee,
    ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"],
    [
      { date: "2026-10-27", status: "present" },
      { date: "2026-10-28", status: "half_day" },
    ],
    [{ days: ["2026-10-29"], unpaid: true }],
  );
  assert.equal(slip.gross, 24000);
  assert.equal(slip.absent, 1);
  assert.equal(slip.unpaid, 1);
  assert.equal(slip.halfDays, 1);
  assert.equal(slip.deduction, 15000);
  assert.equal(slip.net, 9000);
});

test("half-day leave prorates unpaid deduction and does not double-deduct paid leave", () => {
  const e = {
    _id: "e",
    name: "Test",
    code: "E",
    department: "d",
    basicSalary: 20000,
    joinDate: "2026-01-01",
  };
  const days = ["2026-09-15"],
    attendance = [{ date: days[0], status: "half_day" }];
  const paid = salarySlip(e, days, attendance, [
    { days, duration: "half_day", unpaid: false },
  ]);
  assert.equal(paid.deduction, 0);
  const unpaid = salarySlip(e, days, attendance, [
    { days, duration: "half_day", unpaid: true },
  ]);
  assert.equal(unpaid.deduction, 15000);
  assert.equal(unpaid.unpaid, 0.5);
  const missing = salarySlip(
    e,
    days,
    [],
    [{ days, duration: "half_day", unpaid: false }],
  );
  assert.equal(missing.absent, 0.5);
  assert.equal(missing.deduction, 15000);
});
