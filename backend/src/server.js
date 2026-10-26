import "dotenv/config";
import mongoose from "mongoose";
import { app } from "./app.js";
import { connectDatabase } from "./services/database.js";
if (
  !process.env.JWT_SECRET ||
  process.env.JWT_SECRET.length < 32 ||
  process.env.JWT_SECRET.startsWith("replace-")
)
  throw new Error(
    "Set JWT_SECRET to a random value of at least 32 characters in backend/.env.",
  );
await connectDatabase();
const server = app.listen(Number(process.env.PORT) || 4000, () =>
  console.log(`HCM Lite API listening on port ${process.env.PORT || 4000}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    }),
  );
