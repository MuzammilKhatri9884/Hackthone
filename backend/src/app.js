import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import mongoose from "mongoose";
import { api } from "./routes/api.js";
export const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  }),
);
app.use(express.json({ limit: "4mb" }));
app.use((req, res, next) => {
  req.body ??= {};
  next();
});
app.use((req, res, next) => {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin &&
    req.headers.origin !== (process.env.FRONTEND_URL || "http://localhost:3000")
  )
    return res.status(403).json({ message: "Untrusted request origin." });
  next();
});
app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 1000,
    message: {
      message: "Too many requests. Please wait a moment and try again.",
    },
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
app.get("/api/health", (req, res) =>
  res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({
    status:
      mongoose.connection.readyState === 1 ? "ok" : "database unavailable",
  }),
);
app.use("/api", api);
app.use((req, res) => res.status(404).json({ message: "Endpoint not found." }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = err.status || 500,
    message = err.message,
    details = err.details;
  if (err.code === 11000) {
    status = 409;
    message = `A record with this ${Object.keys(err.keyPattern || {}).join(", ") || "value"} already exists.`;
  }
  if (["ValidationError", "CastError", "StrictModeError"].includes(err.name)) {
    status = 422;
    message =
      err.name === "ValidationError"
        ? Object.values(err.errors)
            .map((e) => e.message)
            .join(" ")
        : "Invalid record ID or field.";
  }
  if (err.code === "LIMIT_FILE_SIZE") {
    status = 422;
    message = "CSV must be smaller than 2 MB.";
  }
  if (status >= 500 && !err.status) {
    console.error(err);
    message = "The request could not be completed. Please try again.";
  }
  res.status(status).json({ message, details });
});
