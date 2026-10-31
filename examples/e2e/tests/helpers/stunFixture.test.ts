import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import { e2eRoot } from "./paths.js";
import { rewriteClientHtml } from "./serveClient.js";
import { spawnExampleNodeTs } from "./spawnExample.js";
import {
  localStunHost,
  publicStunHost,
  publicStunPort,
} from "./stunFixture.js";

const stunProbe = path.join(e2eRoot, "tests/helpers/fixtures/stunProbe.ts");

test("client HTML points the public STUN server at the local fixture", () => {
  const html = `iceServers: [{ urls: "stun:${publicStunHost}:${publicStunPort}" }]`;

  // Act: 配信時の HTML 書き換えを通す
  const rewritten = rewriteClientHtml(html, 8888);

  // Assert: 公開 STUN が消え、ローカル fixture の URL になる
  expect(rewritten).not.toContain(publicStunHost);
  expect(rewritten).toContain(`stun:${localStunHost}:${publicStunPort}`);
});

test("example Node processes gather srflx candidates from the local fixture", async () => {
  // Act: example と同じ起動経路で、デモと同じ公開 STUN URL を指定した収集プローブを実行する
  const probe = spawnExampleNodeTs(stunProbe, {
    cwd: e2eRoot,
    env: process.env,
  });
  const exit = await probe.waitForExit();
  const result: {
    elapsedMs: number;
    candidates: { type: string; address: string }[];
  } = JSON.parse(probe.logs.trim().split("\n").at(-1) ?? "{}");

  // Assert: プローブが正常終了し、収集が STUN 待ちで止まらない
  expect(exit.code, probe.logs).toBe(0);
  expect(result.elapsedMs).toBeLessThan(5_000);

  // Assert: srflx は fixture が返すこのマシンのアドレスだけで、公開 STUN の NAT 越しアドレスを含まない
  const localAddresses = Object.values(os.networkInterfaces())
    .flat()
    .map((info) => info?.address);
  const srflx = result.candidates.filter(
    (candidate) => candidate.type === "srflx",
  );
  expect(srflx.length).toBeGreaterThan(0);
  for (const candidate of srflx) {
    expect(localAddresses).toContain(candidate.address);
  }
});
