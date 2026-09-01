import { afterAll } from "vitest";

import { catalogByGroup } from "../helpers/catalog.js";
import { closeSharedBrowser } from "../helpers/openPage.js";
import { assertCatalogEntry, withExample } from "../helpers/runExample.js";

afterAll(async () => {
  await closeSharedBrowser();
});

for (const entry of catalogByGroup("browser").filter((item) =>
  item.node[0].startsWith("datachannel/") || item.node[0].startsWith("close/"),
)) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        // Act / Assert: カタログ種別ごとの必須検証（DC 往復または終段 close）
        await assertCatalogEntry(entry, session, ctx);
      },
      ctx,
    );
  });
}
