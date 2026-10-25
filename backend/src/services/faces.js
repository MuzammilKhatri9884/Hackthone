import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import { Employee } from "../models/index.js";
import { assert, HttpError } from "./rules.js";

const require = createRequire(import.meta.url);
let loading,
  runtime,
  queue = Promise.resolve(),
  pending = 0;
export const FACE_THRESHOLD = 0.5;

async function loadModels() {
  if (!loading)
    loading = (async () => {
      const tf = require("@tensorflow/tfjs");
      const wasm = require("@tensorflow/tfjs-backend-wasm");
      const faceapi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
      wasm.setWasmPaths(
        path.join(
          path.dirname(
            require.resolve("@tensorflow/tfjs-backend-wasm/package.json"),
          ),
          "dist",
        ) + path.sep,
      );
      wasm.setThreadsCount(1);
      await tf.setBackend("wasm");
      await tf.ready();
      const modelPath = path.join(
        path.dirname(require.resolve("@vladmandic/face-api/package.json")),
        "model",
      );
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromDisk(modelPath),
        faceapi.nets.faceLandmark68Net.loadFromDisk(modelPath),
        faceapi.nets.faceRecognitionNet.loadFromDisk(modelPath),
      ]);
      runtime = { tf, faceapi };
      return runtime;
    })().catch((e) => {
      loading = null;
      console.error("Face model initialization failed:", e.name);
      throw new HttpError(
        503,
        "Face verification is temporarily unavailable. Please ask HR for an attendance correction.",
      );
    });
  return loading;
}

export async function normalisePhoto(value) {
  assert(
    typeof value === "string" && value.length <= 2900000,
    422,
    "Choose a JPEG, PNG or WebP photo smaller than 2 MB.",
  );
  const match =
    /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  assert(match, 422, "Upload a valid JPEG, PNG or WebP image.");
  const input = Buffer.from(match[2], "base64");
  const jpeg=input[0]===0xff&&input[1]===0xd8&&input[2]===0xff;
  const png=input.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const webp=input.subarray(0,4).toString()==='RIFF'&&input.subarray(8,12).toString()==='WEBP';
  assert(jpeg||png||webp,422,'Upload a genuine JPEG, PNG or WebP image.');
  assert(
    input.length > 0 && input.length <= 2 * 1024 * 1024,
    422,
    "Photo must be smaller than 2 MB.",
  );
  try {
    const image = sharp(input, { limitInputPixels: 16000000, failOn: "error" });
    const metadata = await image.metadata();
    assert(
      ["jpeg", "png", "webp"].includes(metadata.format) &&
        (!metadata.pages || metadata.pages === 1),
      422,
      "Use a single JPEG, PNG or WebP image.",
    );
    assert(
      metadata.width >= 100 && metadata.height >= 100,
      422,
      "Photo must be at least 100 × 100 pixels.",
    );
    return await image
      .rotate()
      .resize({
        width: 640,
        height: 640,
        fit: "inside",
        withoutEnlargement: true,
      })
      .removeAlpha()
      .toColourspace("srgb")
      .jpeg({ quality: 88 })
      .toBuffer();
  } catch (e) {
    if (e.status) throw e;
    throw new HttpError(
      422,
      "This image could not be read. Choose a clear JPEG, PNG or WebP photo.",
    );
  }
}

export async function extractDescriptor(photo) {
  assert(
    pending < 5,
    429,
    "Face verification is busy. Please try again in a moment.",
  );
  pending++;
  const task = queue.then(async () => {
    const { tf, faceapi } = await loadModels();
    const { data, info } = await sharp(photo)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const tensor = tf.tensor3d(
      new Uint8Array(data),
      [info.height, info.width, 3],
      "int32",
    );
    try {
      const faces = await faceapi
        .detectAllFaces(
          tensor,
          new faceapi.SsdMobilenetv1Options({
            minConfidence: 0.65,
            maxResults: 2,
          }),
        )
        .withFaceLandmarks()
        .withFaceDescriptors();
      assert(
        faces.length === 1,
        422,
        faces.length
          ? "Only one person may be visible. Retake the photo with no other faces."
          : "No clear face was detected. Face the camera in good lighting and try again.",
      );
      return Array.from(faces[0].descriptor);
    } finally {
      tensor.dispose();
    }
  });
  queue = task.catch(() => {});
  try {
    return await task;
  } finally {
    pending--;
  }
}

export function faceDistance(a, b) {
  assert(
    Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === 128 &&
      b.length === 128 &&
      [...a, ...b].every(Number.isFinite),
    422,
    "Invalid face reference. Ask HR to upload your photo again.",
  );
  return Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));
}

export async function enrollPhoto(value) {
  const photoImage = await normalisePhoto(value);
  const faceDescriptor = await extractDescriptor(photoImage);
  return { photoImage, faceDescriptor, faceEnrolledAt: new Date() };
}

export async function verifyEmployeePhoto(id, value) {
  const employee = await Employee.findById(id).select("+faceDescriptor");
  assert(
    employee?.faceEnrolledAt && employee.faceDescriptor?.length === 128,
    422,
    "Ask HR to upload your attendance reference photo in your employee profile before using camera attendance.",
  );
  assert(
    value,
    422,
    "Face verification is required. Use camera check-in and capture your face.",
  );
  const photo = await normalisePhoto(value),
    descriptor = await extractDescriptor(photo);
  const distance = faceDistance(
    Array.from(employee.faceDescriptor),
    descriptor,
  );
  assert(
    distance < FACE_THRESHOLD,
    403,
    "Your face does not match the employee reference photo. Attendance was not recorded. Try better lighting or ask HR to verify your profile photo.",
  );
  return {
    faceCount: 1,
    faceVerified: true,
    faceDistance: Number(distance.toFixed(4)),
  };
}
