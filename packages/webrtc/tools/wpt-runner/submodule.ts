import { spawnSync } from "child_process";
import { access } from "fs/promises";
import { readFileSync } from "fs";
import { resolve } from "path";

export async function ensureWptCheckout(
  repoRoot: string,
  wptRoot: string,
  dependencies: {
    hasWptWebrtcDirectory?: (root: string) => Promise<boolean>;
    updateSubmodule?: (root: string) => void;
    cloneCheckout?: (root: string, wptRoot: string) => void;
  } = {},
) {
  const hasWptWebrtcDirectory =
    dependencies.hasWptWebrtcDirectory ?? defaultHasWptWebrtcDirectory;
  const updateSubmodule = dependencies.updateSubmodule ?? defaultUpdateSubmodule;
  const cloneCheckout = dependencies.cloneCheckout ?? defaultCloneCheckout;

  if (await hasWptWebrtcDirectory(wptRoot)) {
    return false;
  }

  console.error("[wpt] third_party/wpt is missing, initializing the submodule checkout");
  try {
    updateSubmodule(repoRoot);
  } catch (error) {
    console.error("[wpt] submodule initialization failed, falling back to git clone");
    cloneCheckout(repoRoot, wptRoot);
  }

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

function defaultCloneCheckout(repoRoot: string, wptRoot: string) {
  const cloneUrl = resolveWptCloneUrl(repoRoot);
  const result = spawnSync(
    "git",
    ["clone", "--depth", "1", cloneUrl, wptRoot],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`git clone exited with status ${result.status ?? "unknown"}`);
  }
}

function resolveWptCloneUrl(repoRoot: string) {
  try {
    const gitmodules = readFileSync(resolve(repoRoot, ".gitmodules"), "utf8");
    const match = gitmodules.match(
      /\[submodule "third_party\/wpt"\][\s\S]*?url = (.+)/,
    );
    const configuredUrl = match?.[1]?.trim();
    if (!configuredUrl) {
      return "https://github.com/web-platform-tests/wpt.git";
    }
    return configuredUrl.replace("git@github.com:", "https://github.com/");
  } catch {
    return "https://github.com/web-platform-tests/wpt.git";
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
