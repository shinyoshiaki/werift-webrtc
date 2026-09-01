import { afterAll } from "vitest";

import { catalogByGroup } from "../helpers/catalog.js";
import { closeSharedBrowser } from "../helpers/openPage.js";
import { assertCatalogEntry, withExample } from "../helpers/runExample.js";

afterAll(async () => {
  await closeSharedBrowser();
});

for (const entry of catalogByGroup("browser").filter((item) =>
  item.node[0].startsWith("ice/"),
)) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        // Act / Assert: ICE 接続と inbound RTP、restart 後の再接続
        await assertCatalogEntry(entry, session, ctx);
      },
      ctx,
    );
  });
}
