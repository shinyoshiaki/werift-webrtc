/**
 * werift (GCC sender) -> Chrome (recvonly) with the bottleneck on **Chrome's
 * receive path**, shaped by the kernel (tc in a network namespace) instead of
 * werift's ICE send. Not part of CI.
 *
 * Run: `cd e2e && npm run test:sim:netns` (Docker, privileged container).
 * Thresholds are ranges around measured behavior, not libwebrtc values.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { connectSession, type Session, shapeLink } from "./netnsSession";

const last = <T>(items: T[]) => items[items.length - 1]!;
const log = (name: string, data: unknown) =>
  console.log(`[netns-sim] ${name} ${JSON.stringify(data)}`);

describe("e2e/simulations/netns: Chrome 受信側ボトルネックでの GCC", () => {
  let session: Session | undefined;
  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  test("容量 200 kbit に 700 kbps を固定で送り続けると、推定は容量付近まで下がる", async () => {
    // Arrange: 浅いキュー（15 KB）の 200 kbit。RTX なし（probe padding を送らない）
    shapeLink({ rateKbit: 200, limitBytes: 15_000 });
    session = await connectSession({ rtx: false });

    // Act: アプリは推定に追従せず 700 kbps を送り続ける
    const samples = await session.send(8_000, 700_000);
    log("fixed-overshoot", samples);

    // Assert: 3 秒以内に開始値 300 kbps から容量付近まで下がり、0 には張り付かない
    const at3s = samples.find((s) => s.tMs >= 3_000)!;
    assert.ok(at3s.estimateBps < 240_000, `3s: ${at3s.estimateBps}`);
    assert.ok(last(samples).estimateBps < 240_000);
    assert.ok(last(samples).estimateBps > 50_000);
    // Assert: Chrome は受信を続けている
    assert.ok(last(samples).packetsReceived > 100);
  });

  test("深いキューでは遅延で輻輳を検出し、容量の低下に追従して下がる", async () => {
    // Arrange: 深いキュー（100 KB）の 3 Mbit。アプリは推定に追従し、RTX で probe できる
    shapeLink({ rateKbit: 3_000, limitBytes: 100_000 });
    session = await connectSession({ rtx: true });

    // Act 1: 3 Mbit で立ち上がる
    const ramp = await session.send(8_000, "follow");
    // Act 2: 容量を 1 Mbit に下げる
    shapeLink({ rateKbit: 1_000, limitBytes: 100_000 });
    const dropped = await session.send(6_000, "follow");
    log("deep-buffer", { ramp, dropped });

    // Assert: probe で 2 秒以内に 1.5 Mbps を超え、収束後は容量の 50〜110% に収まる
    assert.ok(ramp[1]!.estimateBps > 1_500_000, `2s: ${ramp[1]!.estimateBps}`);
    const settled = last(ramp).estimateBps;
    assert.ok(settled > 1_500_000 && settled < 3_300_000, `8s: ${settled}`);
    // Assert: 容量低下後は 1 Mbit 付近以下まで下がり、0 には張り付かない
    const after = last(dropped).estimateBps;
    assert.ok(after < 1_150_000 && after > 300_000, `after drop: ${after}`);
    // Assert: 遅延で先に下げるので、容量低下後のロスは受信数の 5% 未満
    const lost = last(dropped).packetsLost - last(ramp).packetsLost;
    const received = last(dropped).packetsReceived - last(ramp).packetsReceived;
    assert.ok(lost < received * 0.05, `lost ${lost} / received ${received}`);
  });

  test("ロス 20% が続くと、推定をロスなしのときより大きく下げる", async () => {
    // Arrange: 1 Mbit。アプリは推定に追従し、RTX で probe できる
    shapeLink({ rateKbit: 1_000, limitBytes: 15_000 });
    session = await connectSession({ rtx: true });
    const before = await session.send(5_000, "follow");

    // Act: ランダムロス 20% を加える
    shapeLink({ rateKbit: 1_000, limitBytes: 15_000, lossPercent: 20 });
    const lossy = await session.send(12_000, "follow");
    log("random-loss", { before, lossy });

    // Assert: ロスなしの推定の 70% 未満まで下がり、0 には張り付かない
    const baseline = last(before).estimateBps;
    const end = last(lossy).estimateBps;
    assert.ok(end < baseline * 0.7, `baseline ${baseline} -> ${end}`);
    assert.ok(end > 20_000);
  });
});
