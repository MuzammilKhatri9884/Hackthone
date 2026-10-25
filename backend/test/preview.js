// Manual UI verification server. Ephemeral, empty database; never uses MONGODB_URI.
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import * as models from "../src/models/index.js";
process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
process.env.FRONTEND_URL = "http://localhost:3000";
const { app } = await import("../src/app.js");
const mongo = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
await mongoose.connect(mongo.getUri());
await Promise.all(Object.values(models).map((m) => m.init()));
const server = app.listen(4000, () =>
  console.log(
    "Empty temporary preview API at http://localhost:4000; database is discarded on exit.",
  ),
);
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () =>
    server.close(async () => {
      await mongoose.disconnect();
      await mongo.stop();
      process.exit(0);
    }),
  );
