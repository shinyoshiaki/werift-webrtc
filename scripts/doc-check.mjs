#!/usr/bin/env node
/**
 * Regenerate Typedoc output and fail if `doc/` changes.
 *
 * Uses a before/after tree comparison instead of `git diff` so the check
 * works in container worktrees where `.git` points at an incomplete host
 * relative gitdir (exit 128) even when sources and docs are already in sync.
 */
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpSync } from "node:fs";

const root = process.cwd();
const docDir = join(root, "doc");

async function hashTree(dir) {
  const hash = createHash("sha256");
  if (!existsSync(dir)) {
    return hash.update("<missing>").digest("hex");
  }

  const walk = async (current, prefix) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(path);
      if (st.isDirectory()) {
        await walk(path, rel);
        continue;
      }
      hash.update(rel);
      hash.update("\0");
      await new Promise((resolve, reject) => {
        const stream = createReadStream(path);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", resolve);
      });
      hash.update("\0");
    }
  };

  await walk(dir, "");
  return hash.digest("hex");
}

const tmp = mkdtempSync(join(tmpdir(), "werift-doc-check-"));
const beforeCopy = join(tmp, "doc-before");

try {
  if (existsSync(docDir)) {
    cpSync(docDir, beforeCopy, { recursive: true });
  }

  const before = await hashTree(docDir);
  execFileSync("npm", ["run", "doc"], { stdio: "inherit", cwd: root });
  const after = await hashTree(docDir);

  if (before === after) {
    console.log("doc:check passed: regenerated doc/ matches the pre-generation tree.");
    process.exit(0);
  }

  console.error(
    "doc:check failed: regenerated doc/ differs from the pre-generation tree.",
  );
  console.error("Run `npm run doc` and commit the updated doc/ directory.");

  try {
    execFileSync("diff", ["-ruN", beforeCopy, docDir], {
      stdio: "inherit",
    });
  } catch (error) {
    // diff exits 1 when files differ; any other failure is non-fatal for messaging.
    if (error && typeof error === "object" && "status" in error && error.status !== 1) {
      console.error("(unified diff unavailable)");
    }
  }

  process.exit(1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
