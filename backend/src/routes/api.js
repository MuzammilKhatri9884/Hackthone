import { Router } from "express";
import { enrollPhoto, verifyEmployeePhoto } from "../services/faces.js";
import bcrypt from "bcryptjs";
import multer from "multer";
import csv from "csv-parser";
import { Readable } from "node:stream";
import PDFDocument from "pdfkit";
import { rateLimit } from "express-rate-limit";
import {
  User,
  Settings,
  Department,
  Designation,
  Holiday,
  LeaveType,
  Employee,
  Attendance,
  Correction,
  Leave,
  Payroll,
  Announcement,
  Notification,
  Audit,
} from "../models/index.js";
import {
  auth,
  roles,
  scope,
  ownEmployee,
  safeUser,
  session,
} from "../middleware/auth.js";
import {
  assert,
  isoDate,
  workingDates,
  localParts,
  attendanceResult,
  salarySlip,
  money,
  datesBetween,
} from "../services/rules.js";
import {
  settings,
  audit,
  notify,
  pick,
  paginate,
  escapeRegex,
} from "../services/common.js";
import {
  createEmployee,
  validateEmployee,
  temporaryPassword,
} from "../services/employees.js";
import {
  assertUnlocked,
  assertWorkday,
  attendanceRows,
  markCheckin,
} from "../services/attendance.js";
import { analytics, balances } from "../services/analytics.js";
import { monthlyPerformance } from "../services/performance.js";
import { aiRoutes } from "./ai.js";
export const api = Router();
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const passwordValid = (p) =>
  assert(
    typeof p === "string" && p.length >= 10 && p.length <= 128,
    422,
    "Password must contain 10–128 characters.",
  );
const getEmployeeFilter = (req) =>
  req.user.role === "Employee"
    ? { _id: ownEmployee(req) }
    : req.query.department
      ? { department: req.query.department }
      : {};
api.get("/setup", async (req, res) =>
  res.json({ required: !(await Settings.exists({ _id: "company" })) }),
);
let settingUp = false;
api.post("/setup", loginLimit, async (req, res) => {
  assert(!settingUp, 409, "Company setup is already running.");
  settingUp = true;
  let admin;
  try {
    assert(
      !(await Settings.exists({ _id: "company" })) &&
        !(await User.exists({ role: "Admin" })),
      409,
      "Company is already configured.",
    );
    passwordValid(req.body.password);
    const candidate = new Settings({ companyName: req.body.companyName });
    await candidate.validate();
    admin = await User.create({
      name: req.body.name,
      email: req.body.email,
      password: await bcrypt.hash(req.body.password, 12),
      role: "Admin",
      mustChangePassword: false,
    });
    await candidate.save();
    req.user = admin;
    await audit(req, "create", "company", "company", null, candidate);
    session(res, admin);
    res.status(201).json({ user: safeUser(admin) });
  } catch (e) {
    if (admin && !(await Settings.exists({ _id: "company" })))
      await User.deleteOne({ _id: admin._id });
    throw e;
  } finally {
    settingUp = false;
  }
});
api.post("/auth/login", loginLimit, async (req, res) => {
  const user = await User.findOne({
    email: String(req.body.email || "")
      .trim()
      .toLowerCase(),
  }).select("+password");
  assert(
    user?.active &&
      (await bcrypt.compare(String(req.body.password || ""), user.password)),
    401,
    "Email or password is incorrect.",
  );
  session(res, user);
  res.json({ user: safeUser(user) });
});
api.use(auth);
api.get("/auth/me", (req, res) => res.json({ user: safeUser(req.user) }));
api.post("/auth/logout", (req, res) => {
  res.clearCookie("hcm_token", { path: "/" });
  res.json({ ok: true });
});
api.post("/auth/password", async (req, res) => {
  passwordValid(req.body.password);
  const user = await User.findById(req.user._id).select("+password");
  assert(
    await bcrypt.compare(String(req.body.currentPassword || ""), user.password),
    422,
    "Current password is incorrect.",
  );
  assert(
    !(await bcrypt.compare(req.body.password, user.password)),
    422,
    "Choose a different password.",
  );
  user.password = await bcrypt.hash(req.body.password, 12);
  user.mustChangePassword = false;
  user.tokenVersion++;
  await user.save();
  await audit(req, "change_password", "user", user._id);
  session(res, user);
  res.json({ user: safeUser(user) });
});
api.get("/organization", roles("Admin", "HR"), async (req, res) => {
  const [company, departments, designations, holidays, leaveTypes] =
    await Promise.all([
      settings(),
      Department.find().sort("name"),
      Designation.find().sort("name"),
      Holiday.find().sort("date"),
      LeaveType.find().sort("name"),
    ]);
  res.json({ company, departments, designations, holidays, leaveTypes });
});
api.get("/policy", async (req, res) => {
  const s = await settings();
  res.json({
    companyName: s.companyName,
    officeStart: s.officeStart,
    graceMinutes: s.graceMinutes,
    halfDayHours: s.halfDayHours,
    weekends: s.weekends,
    timezone: s.timezone,
    leaveTypes: await LeaveType.find(),
  });
});
api.patch("/settings", roles("Admin"), async (req, res) => {
  const doc = await Settings.findById("company"),
    before = doc.toObject();
  Object.assign(
    doc,
    pick(req.body, [
      "companyName",
      "officeStart",
      "graceMinutes",
      "halfDayHours",
      "weekends",
      "latitude",
      "longitude",
      "radius",
      "timezone",
    ]),
  );
  await doc.save();
  await audit(req, "update", "settings", "company", before, doc);
  res.json(doc);
});
const catalogs = {
  departments: Department,
  designations: Designation,
  holidays: Holiday,
  "leave-types": LeaveType,
};
for (const [path, Model] of Object.entries(catalogs)) {
  api.post("/organization/" + path, roles("Admin"), async (req, res) => {
    const data = pick(
      req.body,
      path === "holidays"
        ? ["name", "date"]
        : path === "leave-types"
          ? ["name", "quota", "unpaid"]
          : ["name", "description"],
    );
    if (path !== "departments") delete data.description;
    if (path === "holidays")
      assert(isoDate(data.date), 422, "Invalid holiday date.");
    const doc = await Model.create(data);
    await audit(req, "create", path, doc._id, null, doc);
    res.status(201).json(doc);
  });
  api.patch(
    "/organization/" + path + "/:id",
    roles("Admin"),
    async (req, res) => {
      const doc = await Model.findById(req.params.id);
      assert(doc, 404, "Record not found.");
      const before = doc.toObject();
      const fields =
        path === "holidays"
          ? ["name", "date"]
          : path === "leave-types"
            ? ["name", "quota", "unpaid"]
            : path === "departments"
              ? ["name", "description"]
              : ["name"];
      Object.assign(doc, pick(req.body, fields));
      if (path === "holidays")
        assert(isoDate(doc.date), 422, "Invalid holiday date.");
      await doc.save();
      await audit(req, "update", path, doc._id, before, doc);
      res.json(doc);
    },
  );
}
api.get("/users", roles("Admin"), async (req, res) =>
  res.json(await User.find().sort({ createdAt: -1 }).select("-tokenVersion")),
);
api.post("/users", roles("Admin"), async (req, res) => {
  const temp = temporaryPassword();
  const user = await User.create({
    name: req.body.name,
    email: req.body.email,
    password: await bcrypt.hash(temp, 12),
    role: "HR",
    mustChangePassword: true,
  });
  await audit(req, "create", "user", user._id, null, safeUser(user));
  res.status(201).json({ user: safeUser(user), temporaryPassword: temp });
});
api.patch("/users/:id", roles("Admin"), async (req, res) => {
  const u = await User.findById(req.params.id);
  assert(u, 404, "User not found.");
  assert(
    String(u._id) !== String(req.user._id),
    422,
    "Use your profile to manage your own account.",
  );
  assert(
    u.role !== "Admin",
    403,
    "Other administrator accounts cannot be modified here.",
  );
  const before = safeUser(u);
  let temp;
  if (req.body.reset) {
    temp = temporaryPassword();
    u.password = await bcrypt.hash(temp, 12);
    u.mustChangePassword = true;
  }
  if (typeof req.body.active === "boolean") u.active = req.body.active;
  u.tokenVersion++;
  await u.save();
  await audit(
    req,
    req.body.reset ? "reset_password" : "update",
    "user",
    u._id,
    before,
    safeUser(u),
  );
  res.json({ user: safeUser(u), temporaryPassword: temp });
});
api.get("/employees", async (req, res) => {
  const { page, limit } = paginate(req),
    filter = getEmployeeFilter(req);
  if (req.query.search && req.user.role !== "Employee") {
    const re = new RegExp(escapeRegex(req.query.search), "i");
    filter.$or = [{ name: re }, { email: re }, { code: re }];
  }
  if (req.query.status && req.user.role !== "Employee")
    filter.status = req.query.status;
  const [items, total] = await Promise.all([
    Employee.find(filter)
      .populate("department designation")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Employee.countDocuments(filter),
  ]);
  res.json({ items, total, page, pages: Math.ceil(total / limit) });
});
api.get("/employees/export", roles("HR"), async (req, res) => {
  const rows = await Employee.find().lean();
  const fields = [
    "code",
    "name",
    "email",
    "department",
    "designation",
    "joinDate",
    "basicSalary",
    "phone",
    "address",
  ];
  const cell = (v) =>
    '"' +
    String(v ?? "")
      .replace(/^[=+@-]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  res
    .type("text/csv")
    .attachment("employees.csv")
    .send(
      [
        fields.join(","),
        ...rows.map((r) => fields.map((f) => cell(r[f])).join(",")),
      ].join("\r\n"),
    );
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});
api.post(
  "/employees/import",
  roles("HR"),
  upload.single("file"),
  async (req, res) => {
    assert(req.file, 422, "Choose a CSV file.");
    const rows = [];
    await new Promise((resolve, reject) =>
      Readable.from(req.file.buffer)
        .pipe(csv({ strict: true }))
        .on("data", (r) => rows.push(r))
        .on("end", resolve)
        .on("error", () =>
          reject(
            Object.assign(
              new Error("Malformed CSV. Check the headers and columns."),
              { status: 422 },
            ),
          ),
        ),
    );
    assert(
      rows.length > 0 && rows.length <= 500,
      422,
      "Import between 1 and 500 employees.",
    );
    const errors = [],
      emails = new Set(),
      codes = new Set();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      r.basicSalary = r.basicSalary || r.salary;
      r.email = String(r.email || "")
        .trim()
        .toLowerCase();
      for (const e of await validateEmployee(r))
        errors.push({ row: i + 2, ...e });
      if (emails.has(r.email))
        errors.push({
          row: i + 2,
          field: "email",
          reason: "Duplicate email within CSV",
        });
      if (codes.has(r.code))
        errors.push({
          row: i + 2,
          field: "code",
          reason: "Duplicate code within CSV",
        });
      emails.add(r.email);
      codes.add(r.code);
    }
    if (errors.length || req.query.dryRun !== "false")
      return res.json({
        dryRun: true,
        valid: !errors.length,
        count: rows.length,
        errors,
      });
    const created = [];
    for (const row of rows) {
      const result = await createEmployee(row);
      created.push({
        code: result.employee.code,
        email: result.employee.email,
        temporaryPassword: result.temporaryPassword,
      });
      await audit(
        req,
        "import",
        "employee",
        result.employee._id,
        null,
        result.employee,
      );
    }
    res.status(201).json({ count: created.length, created, errors: [] });
  },
);
api.post("/employees", roles("HR"), async (req, res) => {
  const result = await createEmployee(req.body);
  await audit(
    req,
    "create",
    "employee",
    result.employee._id,
    null,
    result.employee,
  );
  res.status(201).json(result);
});
api.post("/employees/:id/photo", roles("Admin", "HR"), async (req, res) => {
  const e = await Employee.findById(req.params.id);
  assert(e, 404, "Employee not found.");
  const enrollment = await enrollPhoto(req.body.photo);
  const before = { faceEnrolledAt: e.faceEnrolledAt };
  Object.assign(e, enrollment);
  await e.save();
  await audit(req, "enroll_face", "employee", e._id, before, {
    faceEnrolledAt: e.faceEnrolledAt,
  });
  res.json({ faceEnrolledAt: e.faceEnrolledAt });
});
api.get("/employees/:id/photo", async (req, res) => {
  if (req.user.role === "Employee")
    assert(
      String(req.user.employee_id) === req.params.id,
      403,
      "You can only view your own reference photo.",
    );
  const e = await Employee.findById(req.params.id).select("+photoImage");
  assert(e?.photoImage, 404, "No reference photo has been uploaded.");
  res
    .set("Cache-Control", "private, no-store")
    .type("image/jpeg")
    .send(e.photoImage);
});
api.get("/employees/:id", async (req, res) => {
  if (req.user.role === "Employee")
    assert(
      String(req.user.employee_id) === req.params.id,
      403,
      "You can only view your own profile.",
    );
  const e = await Employee.findById(req.params.id).populate(
    "department designation",
  );
  assert(e, 404, "Employee not found.");
  res.json(e);
});
api.patch("/employees/:id", roles("HR", "Employee"), async (req, res) => {
  const e = await Employee.findById(req.params.id);
  assert(e, 404, "Employee not found.");
  if (req.user.role === "Employee")
    assert(
      String(req.user.employee_id) === String(e._id),
      403,
      "You can only update your profile.",
    );
  const before = e.toObject(),
    fields =
      req.user.role === "Employee"
        ? ["phone", "address"]
        : [
            "name",
            "department",
            "designation",
            "joinDate",
            "exitDate",
            "status",
            "basicSalary",
            "phone",
            "address",
            "gender",
          ];
  const data = pick(req.body, fields);
  if (req.user.role === "HR") {
    const errors = await validateEmployee({ ...e.toObject(), ...data }, e._id);
    assert(!errors.length, 422, "Employee validation failed.", errors);
  }
  Object.assign(e, data);
  await e.save();
  if (data.name)
    await User.updateOne({ _id: e.user }, { $set: { name: e.name } });
  if (e.status === "exited")
    await User.updateOne(
      { _id: e.user },
      { $set: { active: false }, $inc: { tokenVersion: 1 } },
    );
  await audit(req, "update", "employee", e._id, before, e);
  res.json(e);
});
api.get("/attendance", async (req, res) => {
  const s = await settings(),
    today = localParts(new Date(), s.timezone).date,
    start = req.query.start || today.slice(0, 7) + "-01",
    end = req.query.end || today;
  const employees = await Employee.find(getEmployeeFilter(req))
    .populate("department")
    .lean();
  res.json(await attendanceRows(employees, start, end));
});
api.post("/attendance/manual", roles("HR"), async (req, res) => {
  const { employee_id, checkIn: rawCheckIn, reason: rawReason } = req.body;
  assert(
    typeof employee_id === "string" && /^[a-f\d]{24}$/i.test(employee_id),
    422,
    "Choose a valid employee.",
  );
  assert(
    typeof rawCheckIn === "string" && !isNaN(Date.parse(rawCheckIn)),
    422,
    "Enter a valid clock-in date and time.",
  );
  const checkIn = new Date(rawCheckIn),
    s = await settings(),
    date = localParts(checkIn, s.timezone).date,
    today = localParts(new Date(), s.timezone).date,
    reason = String(rawReason || "").trim();
  assert(date <= today, 422, "Clock-in cannot be in the future.");
  assert(
    reason.length > 0 && reason.length <= 1000,
    422,
    "Add a reason (up to 1000 characters).",
  );
  await assertUnlocked(date);
  await assertWorkday(employee_id, date, s);
  assert(
    !(await Attendance.exists({ employee_id, date })),
    409,
    "Attendance already exists for this employee and date.",
  );
  const record = await Attendance.create({
    employee_id,
    date,
    checkIn,
    ...attendanceResult(checkIn, null, s),
    source: "manual",
    rules: s,
  });
  await audit(req, "manual_check_in", "attendance", record._id, null, {
    ...record.toObject(),
    manualEntryReason: reason,
  });
  const employee = await Employee.findById(employee_id).select("user").lean();
  if (employee?.user)
    await notify(employee.user, `HR manually recorded your clock-in for ${date}.`);
  res.status(201).json(record);
});
api.post("/attendance/check-in", roles("HR", "Employee"), async (req, res) => {
  const id = ownEmployee(req);
  const s = await settings(),
    date = localParts(new Date(), s.timezone).date;
  await assertUnlocked(date);
  assert(
    !(await Attendance.exists({ employee_id: id, date })),
    409,
    "You have already checked in today.",
  );
  let verified;
  try {
    verified = await verifyEmployeePhoto(id, req.body.photo);
  } catch (e) {
    if (e.status === 403)
      await audit(req, "face_verification_failed", "employee", id, null, {
        action: "check_in",
      });
    throw e;
  }
  const extra = { source: "camera", ...verified };
  const a = await markCheckin(id, extra);
  await audit(req, "check_in", "attendance", a._id, null, a);
  res.status(201).json(a);
});
api.post("/attendance/check-out", roles("HR", "Employee"), async (req, res) => {
  const id = ownEmployee(req),
    s = await settings(),
    date = localParts(new Date(), s.timezone).date;
  await assertUnlocked(date);
  const a = await Attendance.findOne({ employee_id: id, date });
  assert(a, 422, "Check in before checking out.");
  assert(!a.checkOut, 409, "You have already checked out.");
  try {
    await verifyEmployeePhoto(id, req.body.photo);
  } catch (e) {
    if (e.status === 403)
      await audit(req, "face_verification_failed", "employee", id, null, {
        action: "check_out",
      });
    throw e;
  }
  const now = new Date(),
    result = attendanceResult(a.checkIn, now, a.rules);
  const updated = await Attendance.findOneAndUpdate(
    { _id: a._id, checkOut: { $exists: false } },
    { $set: { checkOut: now, checkoutFaceVerified: true, ...result } },
    { returnDocument: "after", runValidators: true },
  );
  assert(updated, 409, "You have already checked out.");
  await audit(req, "check_out", "attendance", a._id, a, updated);
  res.json(updated);
});
api.get("/corrections", async (req, res) =>
  res.json(
    await Correction.find(scope(req))
      .populate("employee_id", "name code")
      .sort({ createdAt: -1 })
      .limit(200),
  ),
);
api.post("/corrections", roles("Employee"), async (req, res) => {
  const id = ownEmployee(req),
    s = await settings(),
    { date, checkIn, checkOut, reason } = req.body;
  assert(isoDate(date), 422, "Invalid correction date.");
  assert(
    date <= localParts(new Date(), s.timezone).date,
    422,
    "Future attendance cannot be corrected.",
  );
  await assertUnlocked(date);
  await assertWorkday(id, date, s);
  assert(
    !(await Correction.exists({ employee_id: id, date, status: "pending" })),
    409,
    "A correction is already pending.",
  );
  const previous = await Attendance.findOne({ employee_id: id, date }).lean(),
    rules = previous?.rules || s;
  assert(
    checkIn &&
      checkOut &&
      !isNaN(Date.parse(checkIn)) &&
      !isNaN(Date.parse(checkOut)),
    422,
    "Valid check-in and check-out times are required.",
  );
  assert(
    localParts(new Date(checkIn), rules.timezone).date === date,
    422,
    "Check-in must be on the selected date.",
  );
  assert(
    new Date(checkOut) <= new Date(),
    422,
    "Check-out cannot be in the future.",
  );
  attendanceResult(checkIn, checkOut, rules);
  const c = await Correction.create({
    employee_id: id,
    date,
    checkIn,
    checkOut,
    reason,
    rules,
  });
  await audit(req, "request", "correction", c._id, null, c);
  res.status(201).json(c);
});
api.patch("/corrections/:id", roles("HR"), async (req, res) => {
  const c = await Correction.findById(req.params.id);
  assert(c && c.status === "pending", 409, "Correction is no longer pending.");
  assert(
    String(c.employee_id) !== String(req.user.employee_id),
    403,
    "You cannot approve your own correction.",
  );
  assert(
    ["approved", "rejected"].includes(req.body.status),
    422,
    "Choose approve or reject.",
  );
  assert(
    String(req.body.comment || "").trim(),
    422,
    "A review comment is required.",
  );
  await assertUnlocked(c.date);
  if (req.body.status === "approved") {
    await assertWorkday(c.employee_id, c.date, c.rules);
    await Attendance.findOneAndUpdate(
      { employee_id: c.employee_id, date: c.date },
      {
        $set: {
          checkIn: c.checkIn,
          checkOut: c.checkOut,
          source: "correction",
          rules: c.rules,
          ...attendanceResult(c.checkIn, c.checkOut, c.rules),
        },
      },
      { upsert: true, runValidators: true },
    );
  }
  const before = c.toObject();
  c.status = req.body.status;
  c.comment = req.body.comment;
  c.reviewer = req.user._id;
  await c.save();
  const e = await Employee.findById(c.employee_id);
  await notify(
    e?.user,
    `Attendance correction for ${c.date}: ${c.status}. ${c.comment}`,
  );
  await audit(req, c.status, "correction", c._id, before, c);
  res.json(c);
});
api.get("/leave/balance", roles("HR", "Employee"), async (req, res) =>
  res.json(
    await balances(
      ownEmployee(req),
      Number(req.query.year) || new Date().getFullYear(),
    ),
  ),
);
api.get("/leave", async (req, res) => {
  const requests = await Leave.find(scope(req))
    .populate("employee_id", "name code")
    .populate("type")
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();
  const requesters = await User.find({
    employee_id: {
      $in: requests.map((l) => l.employee_id?._id).filter(Boolean),
    },
  })
    .select("employee_id role")
    .lean();
  res.json(
    requests.map((l) => {
      const requesterRole =
        l.requesterRole ||
        requesters.find(
          (u) => String(u.employee_id) === String(l.employee_id?._id),
        )?.role ||
        "Employee";
      const approverRole =
        l.approverRole || (requesterRole === "HR" ? "Admin" : "HR");
      return {
        ...l,
        requesterRole,
        approverRole,
        totalDays:
          l.totalDays ?? l.days.length * (l.duration === "half_day" ? 0.5 : 1),
        canReview:
          l.status === "pending" &&
          req.user.role === approverRole &&
          String(l.employee_id?._id) !== String(req.user.employee_id),
      };
    }),
  );
});
const leaveLocks = new Set();
async function employeeLock(id, fn) {
  const key = String(id);
  assert(
    !leaveLocks.has(key),
    409,
    "Another leave action is in progress. Please try again.",
  );
  leaveLocks.add(key);
  try {
    return await fn();
  } finally {
    leaveLocks.delete(key);
  }
}
api.post("/leave", roles("HR", "Employee"), async (req, res) =>
  employeeLock(ownEmployee(req), async () => {
    const id = ownEmployee(req),
      { start, end, type, reason } = req.body;
    const duration = req.body.duration || "full_day";
    assert(
      ["full_day", "half_day"].includes(duration),
      422,
      "Choose full-day or half-day leave.",
    );
    assert(
      duration !== "half_day" || start === end,
      422,
      "A half-day request must start and end on the same date.",
    );
    assert(
      isoDate(start) &&
        isoDate(end) &&
        start <= end &&
        start.slice(0, 4) === end.slice(0, 4),
      422,
      "Use a valid date range within one calendar year.",
    );
    for (const date of datesBetween(start, end)) await assertUnlocked(date);
    const s = await settings(),
      t = await LeaveType.findById(type);
    assert(t, 422, "Choose a valid leave type.");
    const employee = await Employee.findById(id);
    assert(
      start >= employee.joinDate &&
        (!employee.exitDate || end <= employee.exitDate),
      422,
      "Leave must be within your employment period.",
    );
    const holidays = await Holiday.find({
      date: { $gte: start, $lte: end },
    }).lean();
    const days = workingDates(
      start,
      end,
      s,
      holidays.map((h) => h.date),
    );
    assert(days.length, 422, "The date range contains no working days.");
    const totalDays = days.length * (duration === "half_day" ? 0.5 : 1);
    assert(
      !(await Leave.exists({
        employee_id: id,
        status: { $in: ["pending", "approved"] },
        days: { $in: days },
      })),
      422,
      "This request overlaps existing leave.",
    );
    const year = Number(start.slice(0, 4)),
      b = (await balances(id, year)).find(
        (v) => String(v._id) === String(t._id),
      );
    assert(
      t.unpaid || b.remaining >= totalDays,
      422,
      "Not enough leave balance.",
    );
    const doc = await Leave.create({
      employee_id: id,
      type: t._id,
      typeName: t.name,
      unpaid: t.unpaid,
      quota: t.quota,
      year,
      start,
      end,
      days,
      duration,
      totalDays,
      requesterRole: req.user.role,
      approverRole: req.user.role === "HR" ? "Admin" : "HR",
      reason,
      rules: s,
    });
    await audit(req, "apply", "leave", doc._id, null, doc);
    const reviewers = await User.find({
      role: doc.approverRole,
      active: true,
    }).select("_id");
    await Promise.all(
      reviewers.map((u) =>
        notify(
          u._id,
          `${req.user.name} requested ${duration === "half_day" ? "half-day " : ""}${t.name} leave for ${start}${end !== start ? " – " + end : ""}. Review it in Time off.`,
        ),
      ),
    );
    res.status(201).json(doc);
  }),
);
api.patch("/leave/:id", async (req, res) => {
  const l = await Leave.findById(req.params.id);
  assert(l, 404, "Leave request not found.");
  await employeeLock(l.employee_id, async () => {
    const before = l.toObject();
    for (const d of l.days) await assertUnlocked(d);
    if (req.body.status === "cancelled") {
      assert(
        String(l.employee_id) === String(req.user.employee_id),
        403,
        "You can only cancel your own leave.",
      );
      assert(
        ["pending", "approved"].includes(l.status),
        409,
        "This request cannot be cancelled.",
      );
      assert(
        l.start >= localParts(new Date(), (await settings()).timezone).date,
        422,
        "Past leave cannot be cancelled.",
      );
    } else {
      const requesterRole =
        l.requesterRole ||
        (await User.findOne({ employee_id: l.employee_id }).select("role"))
          ?.role ||
        "Employee";
      const approverRole =
        l.approverRole || (requesterRole === "HR" ? "Admin" : "HR");
      assert(
        req.user.role === approverRole,
        403,
        `Only ${approverRole} can review this request.`,
      );
      assert(
        String(l.employee_id) !== String(req.user.employee_id),
        403,
        "You cannot review your own leave.",
      );
      assert(l.status === "pending", 409, "Leave is no longer pending.");
      assert(
        ["approved", "rejected"].includes(req.body.status) &&
          String(req.body.comment || "").trim(),
        422,
        "Choose a decision and add a comment.",
      );
      l.reviewer = req.user._id;
      l.comment = req.body.comment;
    }
    l.status = req.body.status;
    await l.save();
    const e = await Employee.findById(l.employee_id);
    await notify(
      e?.user,
      `${l.typeName} leave ${l.start} – ${l.end}: ${l.status}. ${l.comment || ""}`,
    );
    await audit(req, l.status, "leave", l._id, before, l);
    res.json(l);
  });
});
api.get("/payroll", async (req, res) => {
  let runs = await Payroll.find(
    req.user.role === "Employee"
      ? {
          status: "finalized",
          "slips.employee_id": req.user.employee_id || null,
        }
      : {},
  )
    .sort({ month: -1 })
    .lean();
  if (req.user.role === "Employee")
    runs = runs.map((r) => ({
      ...r,
      slips: r.slips.filter(
        (s) => String(s.employee_id) === String(req.user.employee_id),
      ),
      totalGross: undefined,
      totalNet: undefined,
    }));
  res.json(runs);
});
const payrollLocks = new Set();
api.post("/payroll", roles("HR"), async (req, res) => {
  const { month } = req.body;
  assert(
    /^\d{4}-(0[1-9]|1[0-2])$/.test(month),
    422,
    "Choose a valid payroll month.",
  );
  assert(
    !payrollLocks.has(month),
    409,
    "This payroll is already being prepared.",
  );
  payrollLocks.add(month);
  try {
    const previous = await Payroll.findOne({ month });
    assert(
      previous?.status !== "finalized",
      409,
      "Finalized payroll cannot be changed.",
    );
    const s = await settings(),
      start = month + "-01",
      end = new Date(
        Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
      )
        .toISOString()
        .slice(0, 10);
    const [employees, holidays, records, leaves] = await Promise.all([
      Employee.find({
        joinDate: { $lte: end },
        $or: [{ exitDate: null }, { exitDate: { $gte: start } }],
      }).lean(),
      Holiday.find({ date: { $gte: start, $lte: end } }).lean(),
      Attendance.find({ date: { $gte: start, $lte: end } }).lean(),
      Leave.find({
        status: "approved",
        start: { $lte: end },
        end: { $gte: start },
      }).lean(),
    ]);
    assert(
      employees.length,
      422,
      "Register employees before preparing payroll.",
    );
    const working = workingDates(
      start,
      end,
      s,
      holidays.map((h) => h.date),
    );
    const slips = employees.map((e) =>
      salarySlip(
        e,
        working,
        records.filter((r) => String(r.employee_id) === String(e._id)),
        leaves.filter((l) => String(l.employee_id) === String(e._id)),
      ),
    );
    const data = {
      month,
      preparedBy: req.user._id,
      rules: { ...s, holidays: holidays.map((h) => h.date) },
      slips,
      totalGross: money(slips.reduce((n, p) => n + p.gross, 0)),
      totalNet: money(slips.reduce((n, p) => n + p.net, 0)),
    };
    const doc = await Payroll.findOneAndUpdate(
      { month, status: "draft" },
      { $set: data },
      { upsert: true, returnDocument: "after", runValidators: true },
    );
    await audit(req, "prepare", "payroll", doc._id, previous, doc);
    res.status(201).json(doc);
  } finally {
    payrollLocks.delete(month);
  }
});
api.post("/payroll/:id/finalize", roles("Admin"), async (req, res) => {
  const p = await Payroll.findById(req.params.id);
  assert(p, 404, "Payroll not found.");
  assert(
    !payrollLocks.has(p.month),
    409,
    "Payroll preparation is in progress.",
  );
  payrollLocks.add(p.month);
  try {
    const doc = await Payroll.findOneAndUpdate(
      { _id: p._id, status: "draft" },
      {
        $set: {
          status: "finalized",
          finalizedBy: req.user._id,
          finalizedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    assert(doc, 409, "Payroll is already finalized.");
    for (const slip of doc.slips) {
      const e = await Employee.findById(slip.employee_id);
      await notify(
        e?.user,
        `Your payslip for ${doc.month} is ready to download.`,
      );
    }
    await audit(req, "finalize", "payroll", doc._id, p, doc);
    res.json(doc);
  } finally {
    payrollLocks.delete(p.month);
  }
});
api.get("/payroll/:id/payslip/:employeeId", async (req, res) => {
  const p = await Payroll.findById(req.params.id);
  assert(p, 404, "Payroll not found.");
  if (req.user.role === "Employee")
    assert(
      p.status === "finalized" &&
        String(req.user.employee_id) === req.params.employeeId,
      403,
      "You can only download your finalized payslip.",
    );
  const slip = p.slips.find(
    (s) => String(s.employee_id) === req.params.employeeId,
  );
  assert(slip, 404, "Payslip not found.");
  const company = await settings();
  res.type("application/pdf").attachment(`payslip-${p.month}-${slip.code}.pdf`);
  const pdf = new PDFDocument({ size: "A4", margin: 55 });
  pdf.pipe(res);
  pdf.fontSize(23).fillColor("#123d38").text(company.companyName);
  pdf
    .moveDown()
    .fontSize(13)
    .fillColor("#66756f")
    .text(`PAYSLIP / ${p.month} / ${p.status.toUpperCase()}`);
  pdf
    .moveDown()
    .fillColor("#172b27")
    .fontSize(15)
    .text(slip.name)
    .fontSize(11)
    .text(`Employee code: ${slip.code}`);
  pdf.moveDown(2);
  for (const [label, value] of [
    ["Basic salary", slip.basic],
    ["House rent allowance (40%)", slip.hra],
    ["Medical allowance (10%)", slip.medical],
    ["Prorated gross", slip.gross],
    ["Attendance / unpaid deductions", -slip.deduction],
    ["Monthly income tax", -slip.tax],
    ["NET PAY (PKR)", slip.net],
  ]) {
    const y = pdf.y;
    pdf.text(label, 55, y, { width: 340 });
    pdf.text(
      Number(value).toLocaleString("en-PK", { minimumFractionDigits: 2 }),
      395,
      y,
      { width: 140, align: "right" },
    );
    pdf.moveDown();
  }
  pdf
    .moveDown(2)
    .fontSize(10)
    .fillColor("#66756f")
    .text(
      `Working days: ${slip.workingDays} | Eligible: ${slip.eligibleDays} | Absent: ${slip.absent} | Unpaid: ${slip.unpaid} | Half days: ${slip.halfDays}`,
    )
    .moveDown()
    .text(
      "Generated electronically by HCM Lite. Tax follows the illustrative challenge slabs.",
    );
  pdf.end();
});
api.get("/analytics/performance", async (req, res) => {
  const s = await settings();
  const month =
    req.query.month || localParts(new Date(), s.timezone).date.slice(0, 7);
  const employees = await Employee.find(getEmployeeFilter(req)).lean();
  res.json(await monthlyPerformance(employees, month));
});
api.get("/analytics", async (req, res) =>
  res.json(await analytics(req.user, req.query)),
);
api.get("/announcements", async (req, res) =>
  res.json(
    await Announcement.find()
      .populate("author", "name")
      .sort({ createdAt: -1 })
      .limit(100),
  ),
);
api.post("/announcements", roles("Admin", "HR"), async (req, res) => {
  const a = await Announcement.create({
    ...pick(req.body, ["title", "body"]),
    author: req.user._id,
  });
  await audit(req, "create", "announcement", a._id, null, a);
  res.status(201).json(a);
});
api.get("/notifications", async (req, res) =>
  res.json(
    await Notification.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(100),
  ),
);
api.patch("/notifications/read", async (req, res) => {
  await Notification.updateMany(
    { user: req.user._id },
    { $set: { read: true } },
  );
  res.json({ ok: true });
});
api.get("/audit", roles("Admin"), async (req, res) => {
  const { page, limit } = paginate(req);
  res.json({
    items: await Audit.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    total: await Audit.countDocuments(),
    page,
  });
});
api.use("/ai", aiRoutes);
