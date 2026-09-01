import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test } from "vitest";

import {
  assertMediaPidsAlive,
  assertNoFatalLogs,
  commandExists,
  spawnLogged,
  stopProcessTree,
  waitForMediaPids,
  watchUnexpectedExit,
} from "./spawnExample.js";

function skipMissingGst() {
  // gst が無いローカルでは skip。CI では失敗させる
  if (commandExists("gst-launch-1.0")) {
    return false;
  }
  if (process.env.CI) {
    throw new Error("gst-launch-1.0 is not on PATH (required in CI)");
  }
  return true;
}

test("recording gst crash fails the process guard", async (ctx) => {
  if (skipMissingGst()) {
    ctx.skip();
    return;
  }

  const workDir = mkdtempSync(path.join(os.tmpdir(), "werift-ex-guard-"));
  const gst = spawnLogged("gst-launch-1.0", ["videotestsrc", "!", "fakesink"], {
    cwd: workDir,
  });
  try {
    // Arrange: 録画相当の gst を起動し PID を追跡する
    const pids = await waitForMediaPids([gst]);
    expect(pids.size).toBeGreaterThan(0);
    await assertMediaPidsAlive(pids);

    // Act: 意図的に recording プロセスを落とす
    await stopProcessTree(gst.child);
    await delay(200);

    // Assert: 生存確認が失敗すること
    await expect(assertMediaPidsAlive(pids)).rejects.toThrow(
      /ffmpeg\/GStreamer child exited immediately/,
    );
  } finally {
    await stopProcessTree(gst.child);
  }
});

test("non-zero example exit fails immediately", async () => {
  const spawned = spawnLogged(process.execPath, ["-e", "process.exit(2)"], {
    cwd: os.tmpdir(),
  });
  // Arrange: 終了監視を付けてからプロセス終了を待つ
  const guard = watchUnexpectedExit(spawned);
  // Act: 非ゼロ終了を待つ
  await spawned.waitForExit();
  // Assert: ハーネスが即座に失敗すること
  expect(() => guard.throwIfExited()).toThrow(/exited unexpectedly/);
});

test("fatal example log fails the session", () => {
  const spawned = spawnLogged(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
    cwd: os.tmpdir(),
  });
  try {
    Object.defineProperty(spawned, "logs", {
      get() {
        return "Error: baseTime not exist\n";
      },
    });
    // Assert: 未処理の fatal ログを成功扱いにしない
    expect(() => assertNoFatalLogs(spawned)).toThrow(/fatal error/);
  } finally {
    void stopProcessTree(spawned.child);
  }
});
