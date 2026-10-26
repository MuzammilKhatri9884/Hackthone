import mongoose from "mongoose";
import * as models from "../models/index.js";

let databaseReady;

export async function connectDatabase() {
  if (mongoose.connection.readyState === 1) return;
  if (mongoose.connection.readyState === 0) databaseReady = undefined;
  if (!databaseReady) {
    databaseReady = (async () => {
      await mongoose.connect(
        process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/hcm_lite",
        { serverSelectionTimeoutMS: 10000 },
      );
      await Promise.all(Object.values(models).map((model) => model.init()));
    })();
  }
  try {
    await databaseReady;
  } catch (error) {
    databaseReady = undefined;
    throw error;
  }
}
