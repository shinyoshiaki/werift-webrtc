import { afterAll } from "vitest";

import { catalogByGroup } from "../helpers/catalog.js";
import { clickNamedButton, closeSharedBrowser } from "../helpers/openPage.js";
import { withExample } from "../helpers/runExample.js";
import {
  waitDataChannelRoundtrip,
  waitInboundRtp,
  waitPeerConnected,
} from "../helpers/waitPeer.js";

afterAll(async () => {
  await closeSharedBrowser();
});

const entries = catalogByGroup("browser").filter((item) =>
  item.node[0].startsWith("ice/"),
);

for (const entry of entries.filter((item) => item.kind === "datachannel")) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        if (!session.page) throw new Error("page required");
        // Act: trickle ICE のうえ DataChannel を開くのを待つ
        // Assert: ping/pong が少なくとも 1 往復している
        await waitDataChannelRoundtrip(
          session.page,
          25_000,
          () => session.processes[0]?.logs ?? "",
        );
      },
      ctx,
    );
  });
}

for (const entry of entries.filter((item) => item.kind === "media-inbound")) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        if (!session.page) throw new Error("page required");
        // Act: ICE 接続を待つ
        await waitPeerConnected(
          session.page,
          25_000,
          () => session.processes[0]?.logs ?? "",
        );
        // Assert: inbound-rtp の packetsReceived > 0
        await waitInboundRtp(session.page);
      },
      ctx,
    );
  });
}

for (const entry of entries.filter((item) => item.kind === "ice-restart")) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        if (!session.page) throw new Error("page required");
        const logs = () => session.processes[0]?.logs ?? "";
        // Act: 初回接続のあと restart ボタンを押し、再接続を待つ
        await waitPeerConnected(session.page, 25_000, logs);
        await waitInboundRtp(session.page);
        await clickNamedButton(session.page, "restart");
        // Assert: restart 後も connected に戻る
        await waitPeerConnected(session.page, 25_000, logs);
      },
      ctx,
    );
  });
}
