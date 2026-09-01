import { afterAll } from "vitest";

import { catalogByGroup } from "../helpers/catalog.js";
import { closeSharedBrowser } from "../helpers/openPage.js";
import { assertCatalogEntry, withExample } from "../helpers/runExample.js";

afterAll(async () => {
  await closeSharedBrowser();
});

for (const entry of catalogByGroup("ffmpeg-gstreamer")) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        // Act / Assert: 実 gst/ffmpeg 経路で inbound RTP または非空出力
        await assertCatalogEntry(entry, session, ctx);
      },
      ctx,
    );
  });
}
