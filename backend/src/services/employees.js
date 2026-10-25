import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Employee, User, Department, Designation } from "../models/index.js";
import { assert, isoDate } from "./rules.js";
import { pick } from "./common.js";
import { enrollPhoto } from "./faces.js";
export const temporaryPassword = () =>
  crypto.randomBytes(12).toString("base64url") + "!9a";
export async function validateEmployee(data, exclude) {
  const errors = [];
  const error = (field, reason) => errors.push({ field, reason });
  for (const k of [
    "name",
    "code",
    "email",
    "department",
    "designation",
    "joinDate",
    "basicSalary",
  ])
    if (!String(data[k] ?? "").trim()) error(k, "Required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email || ""))
    error("email", "Invalid email format");
  if (!isoDate(data.joinDate))
    error("joinDate", "Use a valid ISO date YYYY-MM-DD");
  if (!(Number(data.basicSalary) > 0))
    error("basicSalary", "Salary must be greater than zero");
  if (
    data.exitDate &&
    (!isoDate(data.exitDate) || data.exitDate < data.joinDate)
  )
    error("exitDate", "Exit date must be on or after joining");
  if (data.status === "exited" && !data.exitDate)
    error("exitDate", "An exit date is required for an exited employee");
  for (const [field, Model] of [
    ["department", Department],
    ["designation", Designation],
  ])
    if (
      !/^[a-f\d]{24}$/i.test(data[field] || "") ||
      !(await Model.exists({ _id: data[field] }))
    )
      error(field, "Unknown reference ID");
  const email = String(data.email || "")
    .trim()
    .toLowerCase();
  const login = !exclude ? await User.findOne({ email }).lean() : null;
  if (
    (await Employee.exists({
      email,
      ...(exclude ? { _id: { $ne: exclude } } : {}),
    })) ||
    (login && !(login.role === "HR" && !login.employee_id))
  )
    error("email", "Email already exists");
  if (
    await Employee.exists({
      code: data.code,
      ...(exclude ? { _id: { $ne: exclude } } : {}),
    })
  )
    error("code", "Employee code already exists");
  return errors;
}
export async function createEmployee(data) {
  const errors = await validateEmployee(data);
  assert(!errors.length, 422, "Employee validation failed.", errors);
  const enrollment = data.referencePhoto
    ? await enrollPhoto(data.referencePhoto)
    : {};
  const temp = temporaryPassword();
  const existingHR = await User.findOne({
    email: String(data.email).toLowerCase(),
    role: "HR",
    employee_id: { $exists: false },
  });
  const employee = await Employee.create({
    ...pick(data, [
      "code",
      "name",
      "email",
      "department",
      "designation",
      "joinDate",
      "exitDate",
      "status",
      "basicSalary",
      "phone",
      "address",
      "gender",
    ]),
    ...enrollment,
  });
  try {
    const user =
      existingHR ||
      (await User.create({
        name: employee.name,
        email: employee.email,
        password: await bcrypt.hash(temp, 12),
        role: "Employee",
        employee_id: employee._id,
        mustChangePassword: true,
      }));
    if (existingHR) {
      user.employee_id = employee._id;
      await user.save();
    }
    employee.user = user._id;
    await employee.save();
    return { employee, temporaryPassword: existingHR ? null : temp };
  } catch (e) {
    await Employee.deleteOne({ _id: employee._id });
    throw e;
  }
}
