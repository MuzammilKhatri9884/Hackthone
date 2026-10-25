// Local convenience runner: real MongoDB, persistent files, no sample data.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
const root = fileURLToPath(new URL("../", import.meta.url));
const envPath = path.join(root, ".env");
if (!fs.existsSync(envPath))
  fs.writeFileSync(
    envPath,
    `PORT=4000\nMONGODB_URI=mongodb://127.0.0.1:27017/hcm_lite\nJWT_SECRET=${crypto.randomBytes(48).toString("hex")}\nFRONTEND_URL=http://localhost:3000\nNODE_ENV=development\nAI_API_KEY=\nAI_BASE_URL=https://api.openai.com/v1\nAI_MODEL=gpt-4o-mini\n`,
    { mode: 0o600 },
  );
dotenv.config({ path: envPath, quiet: true });
if (
  !process.env.JWT_SECRET ||
  process.env.JWT_SECRET.length < 32 ||
  process.env.JWT_SECRET.startsWith("replace-")
)
  throw new Error(
    "Set a random JWT_SECRET of at least 32 characters in backend/.env.",
  );
const dbPath = path.join(root, ".local-db");
fs.mkdirSync(dbPath, { recursive: true });
const cached = path.join(root, "node_modules/.cache/mongod-7.0.14.exe");
const mongo = await MongoMemoryServer.create({
  binary: {
    version: "7.0.14",
    ...(fs.existsSync(cached) ? { systemBinary: cached } : {}),
  },
  instance: {
    dbPath,
    port: 27017,
    dbName: "hcm_lite",
    storageEngine: "wiredTiger",
    launchTimeout: 30000,
    ip: "127.0.0.1",
  },
});
await mongoose.connect(mongo.getUri("hcm_lite"));
const models = await import("../src/models/index.js");
await Promise.all(Object.values(models).map((m) => m.init()));
const { app } = await import("../src/app.js");
const server = app.listen(Number(process.env.PORT) || 4000, () =>
  console.log(
    `HCM Lite API: http://localhost:${process.env.PORT || 4000}\nPersistent local MongoDB: ${dbPath}\nNo sample data is created.`,
  ),
);
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    server.close(async () => {
      await mongoose.disconnect();
      await mongo.stop({ doCleanup: false, force: false });
      process.exit(0);
    });
  });
