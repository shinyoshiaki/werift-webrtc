import { spawnSync } from "child_process";
import { access } from "fs/promises";
import { resolve } from "path";

export async function ensureWptCheckout(
  repoRoot: string,
  wptRoot: string,
  dependencies: {
    hasWptWebrtcDirectory?: (root: string) => Promise<boolean>;
    updateSubmodule?: (root: string) => void;
  } = {},
) {
  const hasWptWebrtcDirectory =
    dependencies.hasWptWebrtcDirectory ?? defaultHasWptWebrtcDirectory;
  const updateSubmodule = dependencies.updateSubmodule ?? defaultUpdateSubmodule;

  if (await hasWptWebrtcDirectory(wptRoot)) {
    return false;
  }

  console.error("[wpt] third_party/wpt is missing, initializing the submodule checkout");
  updateSubmodule(repoRoot);

  if (await hasWptWebrtcDirectory(wptRoot)) {
    return true;
  }

  throw new Error(
    `WPT checkout is still missing after submodule initialization: ${resolve(wptRoot, "webrtc")}`,
  );
}

async function defaultHasWptWebrtcDirectory(wptRoot: string) {
  try {
    await access(resolve(wptRoot, "webrtc"));
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function defaultUpdateSubmodule(repoRoot: string) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "url.https://github.com/.insteadOf=git@github.com:",
      "submodule",
      "update",
      "--init",
      "--recursive",
      "--depth",
      "1",
      "third_party/wpt",
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`git submodule update exited with status ${result.status ?? "unknown"}`);
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
