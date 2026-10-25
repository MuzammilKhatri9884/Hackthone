import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const referencePhoto =
  "data:image/jpeg;base64," +
  readFileSync(new URL("./fixtures/obama.jpg", import.meta.url)).toString(
    "base64",
  );
const otherPhoto =
  "data:image/jpeg;base64," +
  readFileSync(new URL("./fixtures/biden-crop.jpg", import.meta.url)).toString(
    "base64",
  );
import { MongoMemoryServer } from "mongodb-memory-server";
import * as models from "../src/models/index.js";
process.env.JWT_SECRET = "integration-test-secret-with-at-least-32-characters";
const { app } = await import("../src/app.js");
let mongo,
  server,
  base,
  adminCookie,
  hrCookie,
  employeeCookie,
  otherCookie,
  department,
  designation,
  leaveType,
  employee,
  otherEmployee,
  payroll;
async function request(method, path, body, cookie) {
  const headers = {};
  if (body && !(body instanceof FormData))
    headers["Content-Type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const r = await fetch(base + path, {
    method,
    headers,
    body:
      body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const isJson = r.headers.get("content-type")?.includes("application/json");
  return {
    status: r.status,
    data: isJson ? await r.json() : await r.arrayBuffer(),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
before(
  async () => {
    mongo = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
    await mongoose.connect(mongo.getUri());
    await Promise.all(Object.values(models).map((m) => m.init()));
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}/api`;
  },
  { timeout: 180000 },
);
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});
test("fresh database has no company, people, leave types or activity", async () => {
  assert.equal((await request("GET", "/setup")).data.required, true);
  assert.equal(await models.Employee.countDocuments(), 0);
  assert.equal(await models.LeaveType.countDocuments(), 0);
  assert.equal((await request("GET", "/employees")).status, 401);
});
test("first-run setup and admin-only organization actions", async () => {
  let r = await request("POST", "/setup", {
    companyName: "Test company",
    name: "Admin",
    email: "admin@test.example",
    password: "StrongPassword!123",
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  adminCookie = r.cookie;
  assert.equal((await request("POST", "/setup", {})).status, 409);
  r = await request(
    "POST",
    "/organization/departments",
    { name: "Engineering" },
    adminCookie,
  );
  department = r.data._id;
  assert.equal(r.status, 201);
  r = await request(
    "POST",
    "/organization/designations",
    { name: "Engineer" },
    adminCookie,
  );
  designation = r.data._id;
  r = await request(
    "POST",
    "/organization/leave-types",
    { name: "Casual", quota: 10 },
    adminCookie,
  );
  leaveType = r.data._id;
  await request(
    "PATCH",
    "/settings",
    { weekends: [], officeStart: "23:00" },
    adminCookie,
  );
  r = await request(
    "POST",
    "/users",
    { name: "HR", email: "hr@test.example" },
    adminCookie,
  );
  assert.equal(r.status, 201);
  r = await request("POST", "/auth/login", {
    email: "hr@test.example",
    password: r.data.temporaryPassword,
  });
  hrCookie = r.cookie;
  assert.equal(
    (await request("GET", "/employees", null, hrCookie)).status,
    403,
  );
  const u = await models.User.findOne({ email: "hr@test.example" }).select(
    "+password",
  );
  assert.notEqual(u.password, "StrongPassword!123");
  const current = await request(
    "POST",
    "/users",
    { name: "HR2", email: "hr2@test.example" },
    adminCookie,
  );
  assert.equal(current.status, 201);
  const reset = await request(
    "PATCH",
    "/users/" + u._id,
    { reset: true },
    adminCookie,
  );
  r = await request("POST", "/auth/login", {
    email: u.email,
    password: reset.data.temporaryPassword,
  });
  hrCookie = r.cookie;
  r = await request(
    "POST",
    "/auth/password",
    {
      currentPassword: reset.data.temporaryPassword,
      password: "NewHrPassword!123",
    },
    hrCookie,
  );
  assert.equal(r.status, 200);
  hrCookie = r.cookie;
  assert.equal(
    (await request("PATCH", "/settings", { graceMinutes: 0 }, hrCookie)).status,
    403,
  );
});
test("HR creates employees with temporary logins and employee scope blocks colleagues", async () => {
  for (const [name, code, email] of [
    ["Employee One", "E001", "one@test.example"],
    ["Employee Two", "E002", "two@test.example"],
  ]) {
    const r = await request(
      "POST",
      "/employees",
      {
        name,
        code,
        email,
        department,
        designation,
        joinDate: new Date().getUTCFullYear() + "-01-01",
        basicSalary: 40000,
        ...(code === "E001" ? { referencePhoto } : {}),
      },
      hrCookie,
    );
    assert.equal(r.status, 201, JSON.stringify(r.data));
    let login = await request("POST", "/auth/login", {
      email,
      password: r.data.temporaryPassword,
    });
    assert.equal(login.status, 200);
    login = await request(
      "POST",
      "/auth/password",
      {
        currentPassword: r.data.temporaryPassword,
        password: "EmployeePassword!123",
      },
      login.cookie,
    );
    assert.equal(login.status, 200);
    if (code === "E001") {
      employee = r.data.employee;
      employeeCookie = login.cookie;
    } else {
      otherEmployee = r.data.employee;
      otherCookie = login.cookie;
    }
  }
  const r = await request("GET", "/employees", null, employeeCookie);
  assert.equal(r.data.items.length, 1);
  assert.equal(r.data.items[0]._id, employee._id);
  assert.equal(
    (
      await request(
        "GET",
        "/employees/" + otherEmployee._id,
        null,
        employeeCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "PATCH",
        "/employees/" + otherEmployee._id,
        { phone: "123" },
        employeeCookie,
      )
    ).status,
    403,
  );
  await request(
    "PATCH",
    "/employees/" + employee._id,
    { basicSalary: 999999, phone: "123" },
    employeeCookie,
  );
  assert.equal(
    (await models.Employee.findById(employee._id)).basicSalary,
    40000,
  );
  assert.equal((await request("GET", "/audit", null, hrCookie)).status, 403);
});
test("attendance check-in uniqueness is enforced with 409 and server timestamp", async () => {
  for (const faceCount of [0, 2]) {
    const invalid = await request(
      "POST",
      "/attendance/check-in",
      { source: "camera", faceCount },
      employeeCookie,
    );
    assert.equal(invalid.status, 422);
  }
  const a = await request(
    "POST",
    "/attendance/check-in",
    { source: "camera", photo: referencePhoto, checkIn: "2000-01-01" },
    employeeCookie,
  );
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal(a.data.source, "camera");
  assert.equal(a.data.faceCount, 1);
  assert.equal(a.data.faceVerified, true);
  assert.equal(a.data.geo, undefined);
  assert.ok(Math.abs(new Date(a.data.checkIn) - Date.now()) < 10000);
  assert.equal(
    (await request("POST", "/attendance/check-in", undefined, employeeCookie))
      .status,
    409,
  );
  const s = a.data.rules.officeStart;
  await request("PATCH", "/settings", { officeStart: "08:00" }, adminCookie);
  assert.equal(
    (await models.Attendance.findById(a.data._id)).rules.officeStart,
    s,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/attendance/check-out",
        { photo: referencePhoto },
        employeeCookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("POST", "/attendance/check-out", {}, employeeCookie)).status,
    409,
  );
});
test("leave enforces overlap, balance, role review and cancellation", async () => {
  const year = new Date().getUTCFullYear();
  const start = `${year}-11-02`,
    end = `${year}-11-03`;
  let r = await request(
    "POST",
    "/leave",
    { type: leaveType, start, end, reason: "Family wedding" },
    employeeCookie,
  );
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data._id;
  assert.equal(r.data.days.length, 2);
  assert.equal(
    (
      await request(
        "POST",
        "/leave",
        { type: leaveType, start, end, reason: "Overlap" },
        employeeCookie,
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await request(
        "PATCH",
        "/leave/" + id,
        { status: "approved", comment: "Okay" },
        otherCookie,
      )
    ).status,
    403,
  );
  r = await request(
    "PATCH",
    "/leave/" + id,
    { status: "approved", comment: "Enjoy your break" },
    hrCookie,
  );
  assert.equal(r.status, 200);
  const balance = (
    await request("GET", "/leave/balance?year=" + year, null, employeeCookie)
  ).data;
  assert.equal(balance[0].remaining, 8);
  assert.equal(
    (
      await request(
        "POST",
        "/leave",
        {
          type: leaveType,
          start: `${year}-12-01`,
          end: `${year}-12-12`,
          reason: "Over quota",
        },
        employeeCookie,
      )
    ).status,
    422,
  );
  assert.equal(
    (await request("GET", "/leave", null, otherCookie)).data.length,
    0,
  );
});
test("CSV dry-run reports row field reason, makes no writes, and validates duplicates", async () => {
  const form = new FormData();
  form.append(
    "file",
    new Blob(
      [
        `code,name,email,department,designation,joinDate,basicSalary\nE003,Import,invalid,${department},${designation},2026-02-30,0\nE003,Import,invalid,${department},${designation},2026-01-01,1000`,
      ],
      { type: "text/csv" },
    ),
    "people.csv",
  );
  const r = await request(
    "POST",
    "/employees/import?dryRun=true",
    form,
    hrCookie,
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.valid, false);
  assert.ok(
    r.data.errors.some(
      (e) => e.row === 2 && e.field === "joinDate" && e.reason,
    ),
  );
  assert.ok(r.data.errors.some((e) => e.row === 3 && e.field === "code"));
  assert.equal(await models.Employee.countDocuments(), 2);
});
test("payroll draft and finalization RBAC, immutable finalized records, PDF scope", async () => {
  const month = new Date().toISOString().slice(0, 7);
  let r = await request("POST", "/payroll", { month }, hrCookie);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  payroll = r.data;
  assert.equal(
    (
      await request(
        "POST",
        "/payroll/" + payroll._id + "/finalize",
        {},
        hrCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "GET",
        `/payroll/${payroll._id}/payslip/${employee._id}`,
        null,
        employeeCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/payroll/" + payroll._id + "/finalize",
        {},
        adminCookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("POST", "/payroll", { month }, hrCookie)).status,
    409,
  );
  r = await request(
    "GET",
    `/payroll/${payroll._id}/payslip/${employee._id}`,
    null,
    employeeCookie,
  );
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(r.data).subarray(0, 4).toString(), "%PDF");
  assert.equal(
    (
      await request(
        "GET",
        `/payroll/${payroll._id}/payslip/${otherEmployee._id}`,
        null,
        employeeCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("POST", "/attendance/check-in", {}, otherCookie)).status,
    409,
  );
  const runs = (await request("GET", "/payroll", null, employeeCookie)).data;
  assert.equal(runs[0].slips.length, 1);
  assert.equal(runs[0].totalGross, undefined);
});
test("analytics and communications use real scoped records; AI missing key fails gracefully and logs", async () => {
  const d = (await request("GET", "/analytics", null, adminCookie)).data;
  assert.equal(d.headcount, 2);
  const own = (await request("GET", "/analytics", null, employeeCookie)).data;
  assert.equal(own.headcount, 1);
  assert.equal(own.departments.length, 0);
  assert.equal(
    (
      await request(
        "POST",
        "/announcements",
        { title: "Hello", body: "Welcome team" },
        employeeCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/announcements",
        { title: "Hello", body: "Welcome team" },
        hrCookie,
      )
    ).status,
    201,
  );
  assert.equal(
    (await request("GET", "/announcements", null, employeeCookie)).data.length,
    1,
  );
  assert.ok(
    (await request("GET", "/notifications", null, employeeCookie)).data.length >
      0,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/ai/chat",
        { message: "My leave balance?" },
        employeeCookie,
      )
    ).status,
    503,
  );
  assert.equal(await models.AiLog.countDocuments(), 1);
  const audit = (await request("GET", "/audit", null, adminCookie)).data;
  assert.ok(audit.total > 5);
  assert.ok(!JSON.stringify(audit).includes("EmployeePassword"));
});

test("AI tool calls preserve scope, smart-leave validates and retries, summary uses server KPIs", async () => {
  const captures = [];
  let jsonAttempts = 0;
  const provider = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    captures.push(body);
    let message;
    if (body.response_format) {
      jsonAttempts++;
      message = {
        role: "assistant",
        content: JSON.stringify(
          jsonAttempts === 1
            ? { type: "invented", start: "tomorrow" }
            : {
                type: leaveType,
                start: new Date().getUTCFullYear() + "-12-21",
                end: new Date().getUTCFullYear() + "-12-22",
                reason: "Family wedding",
              },
        ),
      };
    } else if (body.tools) {
      const last = body.messages.at(-1);
      message =
        last.role === "tool"
          ? {
              role: "assistant",
              content:
                "Scoped headcount: " + JSON.parse(last.content).headcount,
            }
          : {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_headcount",
                    arguments: JSON.stringify({
                      employee_id: otherEmployee._id,
                    }),
                  },
                },
              ],
            };
    } else
      message = {
        role: "assistant",
        content:
          "- Headcount follows the selected filters.\n- Payroll is based on the prepared run.\n- Attendance uses working-day records.",
      };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((r) => provider.listen(0, r));
  process.env.AI_API_KEY = "test-only-key";
  process.env.AI_BASE_URL = "http://127.0.0.1:" + provider.address().port;
  try {
    let r = await request(
      "POST",
      "/ai/chat",
      { message: "How many employees are in scope?" },
      employeeCookie,
    );
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.answer, "Scoped headcount: 1");
    const tool = captures[1].messages.find((m) => m.role === "tool");
    assert.equal(JSON.parse(tool.content).headcount, 1);
    r = await request(
      "POST",
      "/ai/smart-leave",
      { message: "I need two days for a wedding" },
      employeeCookie,
    );
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.draft.type, leaveType);
    assert.equal(jsonAttempts, 2);
    r = await request("POST", "/ai/summary", { filters: {} }, hrCookie);
    assert.equal(r.status, 200);
    assert.equal(r.data.generated, true);
    assert.ok(
      captures.at(-1).messages.at(-1).content.includes('"headcount":2'),
    );
    r = await request("POST", "/ai/summary", {}, employeeCookie);
    assert.equal(r.status, 403);
    const before = captures.length;
    r = await request(
      "POST",
      "/ai/chat",
      { message: "What is my colleague's salary?" },
      employeeCookie,
    );
    assert.equal(r.status, 200);
    assert.match(r.data.answer, /private/);
    assert.equal(captures.length, before);
    assert.equal(
      await models.Leave.countDocuments(),
      1,
      "Smart-leave does not save without confirmation",
    );
    assert.equal(await models.AiLog.exists({ user: employee._id }), null);
    assert.ok(
      await models.AiLog.exists({
        kind: "chat",
        success: true,
        tools: "get_headcount",
      }),
    );
  } finally {
    delete process.env.AI_API_KEY;
    delete process.env.AI_BASE_URL;
    await new Promise((r) => provider.close(r));
  }
});

test("employee leave routes to HR; HR leave routes to Admin; half days affect balance and attendance", async () => {
  let r = await request(
    "POST",
    "/employees",
    {
      name: "HR",
      code: "HR001",
      email: "hr@test.example",
      department,
      designation,
      joinDate: new Date().getUTCFullYear() + "-01-01",
      basicSalary: 40000,
    },
    hrCookie,
  );
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.temporaryPassword, null);
  const sick = (
    await request(
      "POST",
      "/organization/leave-types",
      { name: "Sick", quota: 8 },
      adminCookie,
    )
  ).data;
  const year = new Date().getUTCFullYear();
  r = await request(
    "POST",
    "/leave",
    {
      type: sick._id,
      start: `${year}-12-14`,
      end: `${year}-12-14`,
      reason: "HR sick leave",
    },
    hrCookie,
  );
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const hrLeave = r.data;
  assert.equal(hrLeave.approverRole, "Admin");
  assert.equal(hrLeave.requesterRole, "HR");
  assert.equal(
    (
      await request(
        "PATCH",
        "/leave/" + hrLeave._id,
        { status: "approved", comment: "Self approval" },
        hrCookie,
      )
    ).status,
    403,
  );
  let list = (await request("GET", "/leave", null, adminCookie)).data;
  assert.equal(list.find((l) => l._id === hrLeave._id).canReview, true);
  assert.ok(
    (await request("GET", "/notifications", null, adminCookie)).data.some(
      (n) => n.message.includes("requested") && n.message.includes("Sick"),
    ),
  );
  assert.equal(
    (
      await request(
        "PATCH",
        "/leave/" + hrLeave._id,
        { status: "approved", comment: "Approved by Admin" },
        adminCookie,
      )
    ).status,
    200,
  );
  const halfDate = `${year}-09-15`,
    fullDate = `${year}-09-16`;
  r = await request(
    "POST",
    "/leave",
    {
      type: sick._id,
      start: halfDate,
      end: halfDate,
      duration: "half_day",
      reason: "Half-day sick leave",
    },
    employeeCookie,
  );
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const half = r.data;
  assert.equal(half.totalDays, 0.5);
  assert.equal(half.approverRole, "HR");
  assert.equal(
    (
      await request(
        "PATCH",
        "/leave/" + half._id,
        { status: "approved", comment: "Wrong reviewer" },
        adminCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "PATCH",
        "/leave/" + half._id,
        { status: "approved", comment: "Approved by HR" },
        hrCookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/leave",
        {
          type: sick._id,
          start: `${year}-09-17`,
          end: `${year}-09-18`,
          duration: "half_day",
          reason: "Invalid multi-day half day",
        },
        employeeCookie,
      )
    ).status,
    422,
  );
  r = await request(
    "POST",
    "/leave",
    { type: sick._id, start: fullDate, end: fullDate, reason: "Sick leave" },
    employeeCookie,
  );
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(
    (
      await request(
        "PATCH",
        "/leave/" + r.data._id,
        { status: "approved", comment: "Approved" },
        hrCookie,
      )
    ).status,
    200,
  );
  r = await request(
    "POST",
    "/corrections",
    {
      date: halfDate,
      checkIn: halfDate + "T04:00:00Z",
      checkOut: halfDate + "T08:00:00Z",
      reason: "Worked the other half of the day",
    },
    employeeCookie,
  );
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(
    (
      await request(
        "PATCH",
        "/corrections/" + r.data._id,
        { status: "approved", comment: "Hours confirmed" },
        hrCookie,
      )
    ).status,
    200,
  );
  const attendance = (
    await request(
      "GET",
      `/attendance?start=${halfDate}&end=${fullDate}`,
      null,
      employeeCookie,
    )
  ).data;
  assert.equal(attendance.find((a) => a.date === halfDate).status, "half_day");
  assert.equal(attendance.find((a) => a.date === halfDate).leaveType, "Sick");
  assert.equal(attendance.find((a) => a.date === fullDate).status, "on_leave");
  const balance = (
    await request("GET", "/leave/balance?year=" + year, null, employeeCookie)
  ).data.find((b) => b._id === sick._id);
  assert.equal(balance.used, 1.5);
  assert.equal(balance.remaining, 6.5);
  assert.equal(
    (
      await request(
        "GET",
        `/analytics?start=${halfDate}&end=${fullDate}`,
        null,
        employeeCookie,
      )
    ).data.attendanceRate,
    100,
  );
});

test("monthly performance keeps today counts separate and enforces employee scope", async () => {
  const month = new Date().getUTCFullYear() + "-09";
  const company = await request(
    "GET",
    "/analytics/performance?month=" + month,
    null,
    adminCookie,
  );
  assert.equal(company.status, 200, JSON.stringify(company.data));
  assert.equal(company.data.month, month);
  assert.equal(company.data.items.length, 3);
  assert.equal(company.data.daily.present, 1);
  assert.equal(company.data.daily.absent, 2);
  const own = await request(
    "GET",
    "/analytics/performance?month=" + month + "&department=" + department,
    null,
    employeeCookie,
  );
  assert.equal(own.status, 200);
  assert.equal(own.data.items.length, 1);
  assert.equal(own.data.items[0].employee_id, employee._id);
  assert.equal(own.data.daily.present, 1);
  assert.equal(own.data.daily.absent, 0);
  assert.equal(own.data.summary.presentDays, 1);
  assert.equal(own.data.summary.leaveDays, 1.5);
  assert.equal(own.data.summary.hours, 4);
  assert.equal(own.data.items[0].basicSalary, undefined);
  assert.equal(
    (
      await request(
        "GET",
        "/analytics/performance?month=2026-13",
        null,
        employeeCookie,
      )
    ).status,
    422,
  );
  assert.equal(
    (await request("GET", "/analytics/performance?month=" + month)).status,
    401,
  );
});

test("reference photos are private and only HR or Admin can enroll them", async () => {
  let r = await request(
    "GET",
    "/employees/" + employee._id,
    null,
    employeeCookie,
  );
  assert.ok(r.data.faceEnrolledAt);
  assert.equal(r.data.photoImage, undefined);
  assert.equal(r.data.faceDescriptor, undefined);
  assert.equal(
    (await request("GET", "/employees/" + employee._id + "/photo")).status,
    401,
  );
  assert.equal(
    (
      await request(
        "GET",
        "/employees/" + employee._id + "/photo",
        null,
        otherCookie,
      )
    ).status,
    403,
  );
  r = await request(
    "GET",
    "/employees/" + employee._id + "/photo",
    null,
    employeeCookie,
  );
  assert.equal(r.status, 200);
  assert.ok(r.data.byteLength > 1000);
  assert.equal(
    (
      await request(
        "POST",
        "/employees/" + employee._id + "/photo",
        { photo: otherPhoto },
        employeeCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/employees/" + employee._id + "/photo",
        { photo: "data:image/jpeg;base64,bm90LWFuLWltYWdl" },
        hrCookie,
      )
    ).status,
    422,
  );
  const audit = (await request("GET", "/audit?limit=100", null, adminCookie))
    .data;
  assert.equal(JSON.stringify(audit).includes("faceDescriptor"), false);
  assert.equal(JSON.stringify(audit).includes("photoImage"), false);
});

test("server matches the enrolled face and rejects another face or a forged browser result", async () => {
  const { verifyEmployeePhoto } = await import("../src/services/faces.js");
  const match = await verifyEmployeePhoto(employee._id, referencePhoto);
  assert.equal(match.faceVerified, true);
  assert.ok(match.faceDistance < 0.5);
  const sharp = (await import("sharp")).default;
  const brighter = await sharp(
    readFileSync(new URL("./fixtures/obama.jpg", import.meta.url)),
  )
    .modulate({ brightness: 1.1 })
    .jpeg({ quality: 82 })
    .toBuffer();
  assert.equal(
    (
      await verifyEmployeePhoto(
        employee._id,
        "data:image/jpeg;base64," + brighter.toString("base64"),
      )
    ).faceVerified,
    true,
  );
  await assert.rejects(
    () => verifyEmployeePhoto(employee._id, otherPhoto),
    (e) => e.status === 403 && /does not match/.test(e.message),
  );
  await assert.rejects(
    () => verifyEmployeePhoto(employee._id, undefined),
    (e) => e.status === 422,
  );
  await assert.rejects(
    () => verifyEmployeePhoto(otherEmployee._id, otherPhoto),
    (e) => e.status === 422 && /upload/.test(e.message),
  );
  const settings = await models.Settings.findById("company");
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: settings.timezone,
  }).format(new Date());
  await models.Payroll.updateOne(
    { _id: payroll._id },
    { $set: { status: "draft" } },
  ); // Isolated test fixture only.
  const before = await models.Attendance.countDocuments();
  const forged = await request(
    "POST",
    "/attendance/check-in",
    { source: "camera", faceCount: 1 },
    otherCookie,
  );
  assert.equal(forged.status, 422);
  assert.equal(await models.Attendance.countDocuments(), before);
  const enroll = await request(
    "POST",
    "/employees/" + otherEmployee._id + "/photo",
    { photo: otherPhoto },
    hrCookie,
  );
  assert.equal(enroll.status, 200, JSON.stringify(enroll.data));
  const mismatch = await request(
    "POST",
    "/attendance/check-in",
    {
      source: "camera",
      faceCount: 1,
      photo: referencePhoto,
      employee_id: employee._id,
    },
    otherCookie,
  );
  assert.equal(mismatch.status, 403, JSON.stringify(mismatch.data));
  assert.equal(await models.Attendance.countDocuments(), before);
  const correct = await request(
    "POST",
    "/attendance/check-in",
    { source: "camera", photo: otherPhoto },
    otherCookie,
  );
  assert.equal(correct.status, 201, JSON.stringify(correct.data));
  assert.equal(correct.data.faceVerified, true);
  // A rejected frame cannot change the already verified record.
  const record = await models.Attendance.findOne({
    employee_id: employee._id,
    date,
  });
  assert.equal(record.faceVerified, true);
  assert.equal(record.checkoutFaceVerified, true);
});
