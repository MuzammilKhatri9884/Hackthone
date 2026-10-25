import mongoose from "mongoose";
const { Schema } = mongoose;
const ref = (name, required = true) => ({
  type: Schema.Types.ObjectId,
  ref: name,
  required,
});
const text = { type: String, required: true, trim: true, maxlength: 200 };
const model = (name, fields, indexes = []) => {
  const schema = new Schema(fields, { timestamps: true, strict: "throw" });
  for (const [keys, opts] of indexes) schema.index(keys, opts);
  return mongoose.model(name, schema);
};
export const User = model("User", {
  name: text,
  email: {
    ...text,
    lowercase: true,
    match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    unique: true,
  },
  password: { type: String, required: true, select: false },
  role: { type: String, enum: ["Admin", "HR", "Employee"], required: true },
  employee_id: ref("Employee", false),
  active: { type: Boolean, default: true },
  mustChangePassword: { type: Boolean, default: true },
  tokenVersion: { type: Number, default: 0 },
});
export const Settings = model("Settings", {
  _id: { type: String, default: "company" },
  companyName: text,
  officeStart: {
    type: String,
    default: "09:00",
    match: /^([01]\d|2[0-3]):[0-5]\d$/,
  },
  graceMinutes: { type: Number, default: 15, min: 0, max: 240 },
  halfDayHours: { type: Number, default: 5, min: 1, max: 12 },
  weekends: {
    type: [Number],
    default: [0, 6],
    validate: (v) =>
      v.length < 7 && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 6),
  },
  latitude: { type: Number, min: -90, max: 90 },
  longitude: { type: Number, min: -180, max: 180 },
  radius: { type: Number, default: 150, min: 1, max: 10000 },
  timezone: {
    type: String,
    default: "Asia/Karachi",
    validate: (v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    },
  },
});
export const Department = model("Department", {
  name: { ...text, unique: true },
  description: { type: String, maxlength: 1000 },
});
export const Designation = model("Designation", {
  name: { ...text, unique: true },
});
export const Holiday = model("Holiday", {
  name: text,
  date: {
    type: String,
    required: true,
    unique: true,
    match: /^\d{4}-\d{2}-\d{2}$/,
  },
});
export const LeaveType = model("LeaveType", {
  name: { ...text, unique: true },
  quota: { type: Number, required: true, min: 0 },
  unpaid: { type: Boolean, default: false },
});
export const Employee = model("Employee", {
  code: { ...text, unique: true },
  name: text,
  email: {
    ...text,
    lowercase: true,
    unique: true,
    match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  },
  department: ref("Department"),
  designation: ref("Designation"),
  user: ref("User", false),
  joinDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  exitDate: { type: String, default: null },
  status: {
    type: String,
    enum: ["active", "probation", "exited"],
    default: "active",
  },
  basicSalary: { type: Number, required: true, min: 0.01 },
  phone: { type: String, default: "", maxlength: 40 },
  address: { type: String, default: "", maxlength: 1000 },
  photoImage: { type: Buffer, select: false },
  faceDescriptor: { type: [Number], select: false, default: undefined },
  faceEnrolledAt: Date,
  gender: {
    type: String,
    enum: ["Female", "Male", "Other", "Prefer not to say"],
    default: "Prefer not to say",
  },
});
Employee.schema.set("toJSON", {
  transform(_doc, result) {
    delete result.photoImage;
    delete result.faceDescriptor;
    return result;
  },
});
export const Attendance = model(
  "Attendance",
  {
    employee_id: ref("Employee"),
    date: { type: String, required: true },
    checkIn: Date,
    checkOut: Date,
    hours: { type: Number, default: 0, min: 0 },
    late: { type: Boolean, default: false },
    status: {
      type: String,
      enum: [
        "present",
        "late",
        "half_day",
        "missing_checkout",
        "absent",
        "on_leave",
      ],
      required: true,
    },
    source: {
      type: String,
      enum: ["web", "camera", "correction", "manual"],
      default: "web",
    },
    rules: { type: Schema.Types.Mixed, required: true },
    geo: { type: Schema.Types.Mixed },
    faceCount: { type: Number, min: 0, max: 1 },
    faceVerified: { type: Boolean, default: false },
    faceDistance: { type: Number, min: 0 },
    checkoutFaceVerified: { type: Boolean, default: false },
  },
  [[{ employee_id: 1, date: 1 }, { unique: true }]],
);
export const Correction = model("Correction", {
  employee_id: ref("Employee"),
  date: { type: String, required: true },
  checkIn: { type: Date, required: true },
  checkOut: { type: Date, required: true },
  reason: { ...text, maxlength: 2000 },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  comment: String,
  reviewer: ref("User", false),
  rules: { type: Schema.Types.Mixed, required: true },
});
export const Leave = model("Leave", {
  employee_id: ref("Employee"),
  type: ref("LeaveType"),
  typeName: String,
  unpaid: Boolean,
  quota: Number,
  year: Number,
  start: { type: String, required: true },
  end: { type: String, required: true },
  days: { type: [String], required: true },
  duration: {
    type: String,
    enum: ["full_day", "half_day"],
    default: "full_day",
  },
  totalDays: { type: Number, min: 0.5 },
  requesterRole: { type: String, enum: ["HR", "Employee"] },
  approverRole: { type: String, enum: ["HR", "Admin"] },
  reason: { ...text, maxlength: 2000 },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected", "cancelled"],
    default: "pending",
  },
  comment: String,
  reviewer: ref("User", false),
  rules: { type: Schema.Types.Mixed, required: true },
});
export const Payroll = model("Payroll", {
  month: { type: String, required: true, unique: true },
  status: { type: String, enum: ["draft", "finalized"], default: "draft" },
  preparedBy: ref("User"),
  finalizedBy: ref("User", false),
  finalizedAt: Date,
  rules: Schema.Types.Mixed,
  slips: [
    {
      employee_id: ref("Employee"),
      name: String,
      code: String,
      department: ref("Department"),
      basic: Number,
      hra: Number,
      medical: Number,
      gross: Number,
      workingDays: Number,
      eligibleDays: Number,
      absent: Number,
      unpaid: Number,
      halfDays: Number,
      deduction: Number,
      tax: Number,
      net: Number,
    },
  ],
  totalGross: Number,
  totalNet: Number,
});
export const Announcement = model("Announcement", {
  title: text,
  body: { type: String, required: true, maxlength: 10000 },
  author: ref("User"),
});
export const Notification = model("Notification", {
  user: ref("User"),
  message: { type: String, required: true },
  read: { type: Boolean, default: false },
});
export const Audit = model("Audit", {
  actor: ref("User", false),
  actorName: String,
  action: text,
  entity: text,
  entityId: String,
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
});
export const AiLog = model("AiLog", {
  user: ref("User"),
  kind: String,
  question: String,
  tools: [String],
  success: Boolean,
  duration: Number,
});
