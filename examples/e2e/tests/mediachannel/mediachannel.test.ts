import { afterAll } from "vitest";

import { catalogByGroup } from "../helpers/catalog.js";
import { closeSharedBrowser } from "../helpers/openPage.js";
import { assertCatalogEntry, withExample } from "../helpers/runExample.js";

afterAll(async () => {
  await closeSharedBrowser();
});

const prefixes = [
  "certificate/",
  "mediachannel/",
  "interop/server.ts",
];

for (const entry of catalogByGroup("browser").filter((item) =>
  prefixes.some((prefix) => item.node[0].startsWith(prefix)),
)) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        // Act / Assert: 接続状態と inbound RTP（または process exit 0）
        await assertCatalogEntry(entry, session, ctx);
      },
      ctx,
    );
  });
}
