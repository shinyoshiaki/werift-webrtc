import path from "node:path";
import { fileURLToPath } from "node:url";

const helpersDir = path.dirname(fileURLToPath(import.meta.url));

export const e2eRoot = path.resolve(helpersDir, "../../");
export const examplesRoot = path.resolve(e2eRoot, "..");
export const repoRoot = path.resolve(examplesRoot, "..");
export const vendorDir = path.join(e2eRoot, "vendor");
export const fixtureWebm = path.join(
  repoRoot,
  "packages/webrtc/tests/data/nonstandard/userMedia-e2e/vp8-opus.webm",
);
export const fixtureMp4 = path.join(
  repoRoot,
  "packages/webrtc/tests/data/nonstandard/userMedia-e2e/h264-opus.mp4",
);

export function examplePath(relative: string) {
  return path.join(examplesRoot, relative);
}
