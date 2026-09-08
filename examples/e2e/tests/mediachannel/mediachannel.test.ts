import { afterAll } from "vitest";

import { catalogByGroup } from "../helpers/catalog.js";
import { closeSharedBrowser } from "../helpers/openPage.js";
import { withExample } from "../helpers/runExample.js";
import { waitForLog } from "../helpers/spawnExample.js";
import {
  waitInboundRtp,
  waitPeerConnected,
  waitSpawnedExit,
  waitUdpPackets,
  waitWeriftRtp,
} from "../helpers/waitPeer.js";

afterAll(async () => {
  await closeSharedBrowser();
});

const entries = catalogByGroup("browser").filter((item) =>
  ["certificate/", "mediachannel/", "interop/server.ts"].some((prefix) =>
    item.node[0].startsWith(prefix),
  ),
);

for (const entry of entries.filter((item) => item.kind === "process-exit")) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        // Act: dump デモがキーフレーム受信で終了するのを待つ
        // Assert: 終了コード 0
        await waitSpawnedExit(
          session.processes[0],
          entry.expectExit ?? 0,
        );
      },
      ctx,
    );
  });
}

for (const entry of entries.filter((item) => item.weriftRtpLogs)) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        if (!session.page) throw new Error("page required");
        const primary = session.processes[0];
        if (!primary) throw new Error("example process required");
        const logs = () => primary.logs;

        // Act: 2本の simulcast トラックを送信して接続を成立させる
        await waitPeerConnected(session.page, 25_000, logs);
        for (const marker of entry.weriftRtpLogs ?? []) {
          // Assert: werift 側で各トラックの RTP を個別に受信する
          await waitForLog(primary, marker, 25_000);
        }
      },
      ctx,
    );
  });
}

for (const entry of entries.filter(
  (item) => item.kind === "media-inbound" && !item.weriftRtpLogs,
)) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        if (!session.page) throw new Error("page required");
        const logs = () => session.processes[0]?.logs ?? "";
        try {
          // Act: ICE 接続を待つ（画質や video.play 完了は必須にしない）
          await waitPeerConnected(session.page, 25_000, logs);
        } catch (error) {
          if (entry.skipIfNoAv1) {
            console.warn(`skip ${entry.id}: AV1 did not connect`);
            ctx.skip();
            return;
          }
          throw error;
        }
        if (entry.inbound === "werift") {
          if (session.udpListener) {
            // Assert: 転送先 UDP に RTP が届いている
            await waitUdpPackets(session.udpListener);
          } else {
            // Assert: werift 側が RTP を受けた（codec の keyframe ログなど）
            await waitWeriftRtp(logs);
          }
        } else {
          // Assert: connectionState が connected かつ inbound-rtp の packetsReceived > 0
          await waitInboundRtp(session.page);
        }
      },
      ctx,
    );
  });
}
