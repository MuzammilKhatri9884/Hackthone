import jwt from "jsonwebtoken";
import { User } from "../models/index.js";
import { assert } from "../services/rules.js";
export async function auth(req, res, next) {
  try {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("hcm_token="))
      ?.slice(10);
    const token =
      cookie ||
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : null);
    assert(token, 401, "Please sign in.");
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET, {
        algorithms: ["HS256"],
      });
    } catch {
      assert(false, 401, "Your session has expired. Please sign in again.");
    }
    const user = await User.findById(payload.sub);
    assert(
      user?.active && user.tokenVersion === payload.v,
      401,
      "This session is no longer active.",
    );
    req.user = user;
    if (
      user.mustChangePassword &&
      !["/auth/me", "/auth/password", "/auth/logout", "/bootstrap"].includes(
        req.path,
      )
    )
      assert(false, 403, "Change your temporary password before continuing.");
    next();
  } catch (e) {
    next(e);
  }
}
export const roles =
  (...allowed) =>
  (req, res, next) => {
    try {
      assert(
        allowed.includes(req.user.role),
        403,
        "Your role cannot perform this action.",
      );
      next();
    } catch (e) {
      next(e);
    }
  };
export const scope = (req) =>
  req.user.role === "Employee"
    ? { employee_id: req.user.employee_id || null }
    : {};
export const ownEmployee = (req) => {
  assert(
    req.user.employee_id,
    422,
    "Your login is not linked to an employee. Ask HR to link your account.",
  );
  return req.user.employee_id;
};
export const safeUser = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  employee_id: user.employee_id,
  mustChangePassword: user.mustChangePassword,
  active: user.active,
});
export function session(res, user) {
  const token = jwt.sign(
    { sub: String(user._id), v: user.tokenVersion },
    process.env.JWT_SECRET,
    { expiresIn: "8h", algorithm: "HS256" },
  );
  res.cookie("hcm_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 8 * 3600000,
    path: "/",
  });
}
