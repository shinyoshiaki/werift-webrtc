import { afterAll } from "vitest";

import { catalogByGroup } from "../helpers/catalog.js";
import { closeSharedBrowser } from "../helpers/openPage.js";
import { withExample } from "../helpers/runExample.js";
import {
  assertMediaPidsAlive,
  assertGstreamerHealthy,
  assertNoFatalLogs,
  waitForLog,
} from "../helpers/spawnExample.js";
import {
  waitInboundRtp,
  assertValidMediaContainer,
  waitNonEmptyOutput,
  waitPeerConnected,
  waitSpawnedExit,
  waitUdpPackets,
  waitWeriftRtp,
} from "../helpers/waitPeer.js";

afterAll(async () => {
  await closeSharedBrowser();
});

const entries = catalogByGroup("ffmpeg-gstreamer");

for (const entry of entries.filter((item) => item.kind === "media-inbound")) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        if (session.mediaPids.size > 0) {
          await assertMediaPidsAlive(session.mediaPids);
        }
        if (!session.page) throw new Error("page required");
        const logs = () => session.processes[0]?.logs ?? "";
        // Act: 実 gst/ffmpeg（またはフィクスチャ再生）経路で接続する
        await waitPeerConnected(session.page, 25_000, logs);
        if (entry.inbound === "werift") {
          if (session.udpListener) {
            await waitUdpPackets(session.udpListener);
          } else if (!entry.outputGlob) {
            await waitWeriftRtp(logs);
          }
        } else {
          // Assert: inbound-rtp の packetsReceived > 0
          await waitInboundRtp(session.page);
        }
        if (entry.outputGlob) {
          // Assert: GStreamer/録画経路が実際に出力したファイルが空でない
          await waitNonEmptyOutput(session.workDir, entry.outputGlob, 20_000);
          if (session.mediaPids.size > 0) {
            // Assert: 出力確認時点でも gst/ffmpeg が異常終了していない
            await assertMediaPidsAlive(session.mediaPids);
          }
          if (entry.stopAfterOutput) {
            if (!session.processes[0]) throw new Error("example process required");
            // Act: 出力確認後に常駐する example をテストから正常停止する
            await session.stop();
            // Assert: Node example が正常終了し、GStreamer の状態を報告する
            await waitSpawnedExit(session.processes[0], 0);
            assertGstreamerHealthy(session.processes[0], { requireExit: true });
          }
          if (entry.outputContainer) {
            // Assert: 非空ファイルが期待するコンテナとして読める
            await assertValidMediaContainer(
              session.workDir,
              entry.outputGlob,
              entry.outputContainer,
            );
          }
        }
      },
      ctx,
    );
  });
}

for (const entry of entries.filter((item) => item.kind === "media-record")) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        const primary = session.processes[0];
        if (session.page) {
          // Act: ICE 接続を待つ
          await waitPeerConnected(session.page);
        }
        if (primary) {
          // Assert: stop まで進み、gst が途中で落ちていない
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
          // Assert: 録画ファイルが空でないこと
          await waitNonEmptyOutput(session.workDir, entry.outputGlob, 10_000);
        }
      },
      ctx,
    );
  });
}

for (const entry of entries.filter((item) => item.kind === "process-exit")) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        if (entry.outputGlob && session.page) {
          const logs = () => session.processes[0]?.logs ?? "";
          // Act: ブラウザとの接続を成立させ、録画入力を流す
          await waitPeerConnected(session.page, 25_000, logs);
        }
        if (session.mediaPids.size > 0) {
          // Assert: 録画用の gst/ffmpeg が接続後も生存している
          await assertMediaPidsAlive(session.mediaPids);
        }
        // Act: gst 経路のデモが自ら終了するのを待つ
        // Assert: 終了コード 0
        await waitSpawnedExit(
          session.processes[0],
          entry.expectExit ?? 0,
          entry.recordWaitMs != null ? entry.recordWaitMs + 25_000 : 40_000,
        );
        assertNoFatalLogs(session.processes[0]);
        if (entry.outputGlob) {
          // Assert: GStreamer が生成した録画ファイルが空でない
          await waitNonEmptyOutput(session.workDir, entry.outputGlob, 10_000);
          if (entry.rtpLog) {
            // Assert: werift から録画用 gst へ実RTPが到達している
            await waitForLog(session.processes[0], entry.rtpLog, 5_000);
          }
          assertGstreamerHealthy(session.processes[0], {
            requireExit: true,
          });
          if (entry.outputContainer) {
            // Assert: opus.webm が WebM コンテナとして読める
            await assertValidMediaContainer(
              session.workDir,
              entry.outputGlob,
              entry.outputContainer,
            );
          }
        }
      },
      ctx,
    );
  });
}

for (const entry of entries.filter((item) => item.kind === "node-gst")) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        const extra = entry.extraGstPorts?.length ?? 0;
        const primary = session.processes[extra];
        if (session.mediaPids.size > 0) {
          await assertMediaPidsAlive(session.mediaPids);
        }
        if (entry.expectExit != null) {
          const client = session.processes[extra + 1] ?? primary;
          // Act: interop client が gst 送信後に終了するのを待つ
          // Assert: 終了コード 0
          await waitSpawnedExit(client, entry.expectExit);
          return;
        }
        if (entry.outputGlob && primary) {
          // Act: audiotestsrc 録画が stop するまで待つ
          await waitForLog(
            primary,
            "stop",
            (entry.recordWaitMs ?? 8_000) + 5_000,
          );
          assertNoFatalLogs(primary);
          // Assert: 出力 webm が空でない
          await waitNonEmptyOutput(session.workDir, entry.outputGlob, 10_000);
        }
      },
      ctx,
    );
  });
}
