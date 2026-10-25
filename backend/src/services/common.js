import { Audit, Notification, Settings } from "../models/index.js";
import { assert } from "./rules.js";
export const settings = async () => {
  const s = await Settings.findById("company").lean();
  assert(s, 409, "Complete company setup first.");
  return s;
};
const redact = (value) => {
  if (!value) return value;
  const clone = JSON.parse(JSON.stringify(value));
  for (const k of ["password", "tokenVersion"]) delete clone[k];
  return clone;
};
export async function audit(req, action, entity, id, before, after) {
  await Audit.create({
    actor: req.user?._id,
    actorName: req.user?.name || "First-run setup",
    action,
    entity,
    entityId: String(id),
    before: redact(before),
    after: redact(after),
  });
}
export const notify = async (user, message) => {
  if (user) await Notification.create({ user, message });
};
export const pick = (obj, keys) =>
  Object.fromEntries(
    keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]),
  );
export const paginate = (req) => ({
  page: Math.min(100000, Math.max(1, Math.floor(Number(req.query.page)) || 1)),
  limit: Math.min(100, Math.max(1, Math.floor(Number(req.query.limit)) || 12)),
});
export const escapeRegex = (s) =>
  String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
