import { afterAll } from "vitest";

import { catalogByGroup } from "../helpers/catalog.js";
import { closeSharedBrowser } from "../helpers/openPage.js";
import { withExample } from "../helpers/runExample.js";
import {
  assertMediaPidsAlive,
  assertNoFatalLogs,
  waitForLog,
} from "../helpers/spawnExample.js";
import { waitNonEmptyOutput, waitPeerConnected } from "../helpers/waitPeer.js";

afterAll(async () => {
  await closeSharedBrowser();
});

for (const entry of catalogByGroup("browser").filter((item) =>
  item.node[0].startsWith("save_to_disk/"),
)) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        const primary = session.processes[0];
        if (session.page) {
          try {
            // Act: ICE 接続を待つ。失敗は成功扱いにしない
            await waitPeerConnected(session.page);
          } catch (error) {
            if (entry.skipIfNoAv1) {
              console.warn(`skip ${entry.id}: AV1 did not connect`);
              ctx.skip();
              return;
            }
            throw error;
          }
        }
        if (primary) {
          // Assert: デモが stop まで進み、途中で例外終了していない
          await waitForLog(
            primary,
            "stop",
            (entry.recordWaitMs ?? 15_000) + 10_000,
          );
          assertNoFatalLogs(primary);
        }
        if (session.mediaPids.size > 0) {
          await assertMediaPidsAlive(session.mediaPids);
        }
        if (entry.outputGlob) {
          try {
            // Assert: 録画ファイルが空でないこと
            await waitNonEmptyOutput(session.workDir, entry.outputGlob, 10_000);
          } catch (error) {
            if (entry.skipIfNoAv1) {
              console.warn(`skip ${entry.id}: AV1 recording was empty`);
              ctx.skip();
              return;
            }
            throw error;
          }
        }
      },
      ctx,
    );
  });
}
