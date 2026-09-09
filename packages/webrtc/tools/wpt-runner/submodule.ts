import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { isAbsolute, resolve } from "path";
import { access } from "fs/promises";

export async function ensureWptCheckout(
  repoRoot: string,
  wptRoot: string,
  dependencies: {
    hasWptWebrtcDirectory?: (root: string) => Promise<boolean>;
    updateSubmodule?: (root: string) => void;
    forceCheckoutSubmodule?: (root: string, wptRoot: string) => void;
    cloneCheckout?: (root: string, wptRoot: string) => void;
  } = {},
) {
  const hasWptWebrtcDirectory =
    dependencies.hasWptWebrtcDirectory ?? defaultHasWptWebrtcDirectory;
  const updateSubmodule =
    dependencies.updateSubmodule ?? defaultUpdateSubmodule;
  const forceCheckoutSubmodule =
    dependencies.forceCheckoutSubmodule ?? defaultForceCheckoutSubmodule;
  const cloneCheckout = dependencies.cloneCheckout ?? defaultCloneCheckout;

  if (await hasWptWebrtcDirectory(wptRoot)) {
    return false;
  }

  console.error(
    "[wpt] third_party/wpt is missing, initializing the submodule checkout",
  );
  try {
    updateSubmodule(repoRoot);
  } catch {
    console.error("[wpt] submodule initialization failed");
  }

  if (await hasWptWebrtcDirectory(wptRoot)) {
    return true;
  }

  // `git submodule update` can exit 0 in linked worktrees while the working
  // tree stays empty because HEAD already matches the recorded gitlink.
  console.error("[wpt] submodule working tree is empty, forcing checkout");
  try {
    forceCheckoutSubmodule(repoRoot, wptRoot);
  } catch {
    console.error(
      "[wpt] forced submodule checkout failed, falling back to git clone",
    );
    try {
      cloneCheckout(repoRoot, wptRoot);
    } catch {
      // Combined failure is reported after the last existence check.
    }
  }

  if (await hasWptWebrtcDirectory(wptRoot)) {
    return true;
  }

  console.error(
    "[wpt] checkout still missing after force, falling back to git clone",
  );
  try {
    cloneCheckout(repoRoot, wptRoot);
  } catch {
    // Combined failure is reported below.
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

function gitSpawnEnv() {
  const {
    GIT_DIR: _gitDir,
    GIT_COMMON_DIR: _gitCommonDir,
    ...env
  } = process.env;
  return env;
}

function runGit(args: string[], repoRoot: string) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: gitSpawnEnv(),
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited with status ${result.status ?? "unknown"}`,
    );
  }

  return result;
}

function defaultUpdateSubmodule(repoRoot: string) {
  runGit(
    [
      "-c",
      "url.https://github.com/.insteadOf=git@github.com:",
      "submodule",
      "update",
      "--init",
      "--recursive",
      "--force",
      "--checkout",
      "--depth",
      "1",
      "third_party/wpt",
    ],
    repoRoot,
  );
}

function defaultForceCheckoutSubmodule(repoRoot: string, wptRoot: string) {
  const gitDir = resolveSubmoduleGitDir(repoRoot, wptRoot);
  runGit(
    ["--git-dir", gitDir, "--work-tree", wptRoot, "checkout", "-f", "HEAD"],
    repoRoot,
  );
}

function resolveSubmoduleGitDir(repoRoot: string, wptRoot: string) {
  const result = spawnSync(
    "git",
    ["rev-parse", "--git-path", "modules/third_party/wpt"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: gitSpawnEnv(),
    },
  );

  if (result.status === 0) {
    const raw = result.stdout.trim();
    if (raw) {
      return isAbsolute(raw) ? raw : resolve(repoRoot, raw);
    }
  }

  const gitfile = readFileSync(resolve(wptRoot, ".git"), "utf8").trim();
  const match = gitfile.match(/^gitdir:\s*(.+)$/m);
  if (!match?.[1]) {
    throw new Error(`unable to resolve third_party/wpt gitdir from ${wptRoot}`);
  }
  const gitdir = match[1].trim();
  return isAbsolute(gitdir) ? gitdir : resolve(wptRoot, gitdir);
}

function defaultCloneCheckout(repoRoot: string, wptRoot: string) {
  const cloneUrl = resolveWptCloneUrl(repoRoot);
  runGit(["clone", "--depth", "1", cloneUrl, wptRoot], repoRoot);
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
