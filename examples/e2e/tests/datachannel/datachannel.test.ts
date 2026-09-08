import { afterAll } from "vitest";

import { catalogByGroup } from "../helpers/catalog.js";
import { closeSharedBrowser } from "../helpers/openPage.js";
import { withExample } from "../helpers/runExample.js";
import {
  waitDataChannelClosed,
  waitDataChannelRoundtrip,
  waitPeerClosed,
} from "../helpers/waitPeer.js";

afterAll(async () => {
  await closeSharedBrowser();
});

const entries = catalogByGroup("browser").filter(
  (item) =>
    item.node[0].startsWith("datachannel/") ||
    item.node[0].startsWith("close/"),
);

for (const entry of entries.filter((item) => item.kind === "datachannel")) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        if (!session.page) throw new Error("page required");
        // Act: HTML がマウント直後にシグナリングし DataChannel を開くのを待つ
        // Assert: readyState=open のあと ping/pong が少なくとも 1 往復している
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

for (const entry of entries.filter((item) => item.kind === "close-dc")) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        if (!session.page) throw new Error("page required");
        // Act: デモが DC を閉じるまで待つ
        // Assert: closing / closed まで進む
        await waitDataChannelClosed(
          session.page,
          25_000,
          () => session.processes[0]?.logs ?? "",
        );
      },
      ctx,
    );
  });
}

for (const entry of entries.filter((item) => item.kind === "close-pc")) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        if (!session.page) throw new Error("page required");
        // Act: デモが PeerConnection を閉じるまで待つ
        // Assert: closed / disconnected まで進む
        await waitPeerClosed(
          session.page,
          25_000,
          () => session.processes[0]?.logs ?? "",
        );
      },
      ctx,
    );
  });
}
