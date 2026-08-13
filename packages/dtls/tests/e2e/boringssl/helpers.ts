import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

import { readFileSync } from "fs";

/** Pinned BoringSSL revision (BORINGSSL_REVISION file is source of truth). */
export const BORINGSSL_PIN_REVISION = (() => {
  try {
    const candidates = [
      join(__dirname, "../../../tools/boringssl-dtls13/BORINGSSL_REVISION"),
      join(__dirname, "BORINGSSL_REVISION"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        return readFileSync(p, "utf8").trim();
      }
    }
  } catch {
    /* fall through */
  }
  return "0bcc1e8473a1264b4de88e05a651763dc9a71b09";
})();

/** Path written by fetch-and-build-boringssl.sh after a successful pin build. */
export function readBuiltRevision(): string | undefined {
  const p = join(__dirname, ".built-revision");
  if (!existsSync(p)) return undefined;
  return readFileSync(p, "utf8").trim();
}

export function resolveBsslPath(): string | undefined {
  if (process.env.WERIFT_BORINGSSL_BSSL) {
    return process.env.WERIFT_BORINGSSL_BSSL;
  }
  const candidates = [
    join(process.cwd(), "third_party/boringssl/build/tool/bssl"),
    join(process.cwd(), "../../third_party/boringssl/build/tool/bssl"),
    "/usr/local/bin/bssl",
  ];
  return candidates.find((p) => existsSync(p));
}

export function requireBsslOrSkip(): string {
  const path = resolveBsslPath();
  if (!path) {
    // Local skip with reason; required CI must set WERIFT_BORINGSSL_BSSL
    return "";
  }
  return path;
}

export function spawnBssl(
  args: string[],
  bsslPath: string,
): ChildProcessWithoutNullStreams {
  const child = spawn(bsslPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return child;
}

export async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `bssl timeout after ${timeoutMs}ms\nstdout=${stdout}\nstderr=${stderr}`,
        ),
      );
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}
