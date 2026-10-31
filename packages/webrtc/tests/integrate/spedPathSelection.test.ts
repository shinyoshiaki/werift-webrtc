import { setTimeout } from "timers/promises";

import type { RTCDataChannel } from "../../src";
import { exchangeIceCandidates } from "../utils";
import {
  collectMessages,
  createDualFamilyLoopbackSpedPeers,
  steerToDifferentFamilies,
  waitForBothFamilySucceeded,
} from "./warpArrange";

describe("SPED path selection", () => {
  test("両端の選択経路が IPv4 / IPv6 に分かれても、相手の認証済み経路の DTLS を受け取り DataChannel が通る", async () => {
    // Arrange: 127.0.0.1 と ::1 だけを候補にした SPED 接続で DataChannel を開く。
    const { caller, callee } = createDualFamilyLoopbackSpedPeers();
    try {
      const callerChannel = caller.createDataChannel("path");
      const calleeChannel = new Promise<RTCDataChannel>((resolve) => {
        callee.onDataChannel.subscribe(resolve);
      });
      exchangeIceCandidates(caller, callee);
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setLocalDescription(await callee.createAnswer());
      await caller.setRemoteDescription(callee.localDescription!);
      const remote = await calleeChannel;
      if (remote.readyState !== "open") {
        await new Promise<void>((resolve) => {
          remote.onopen = () => resolve();
        });
      }
      // 両 family の pair が両端で check を終えるまで待つ。
      await waitForBothFamilySucceeded([caller, callee]);

      // Act: caller は一方の family、callee は他方の family を選び、callee が送る。
      const { receiverPairOfSenderPath } = steerToDifferentFamilies(
        caller,
        callee,
      );
      const arrived = collectMessages(callerChannel, 1);
      remote.send("over-the-other-family");

      // Assert: caller が選んでいない経路でも、認証済み pair の record は届く。
      expect(receiverPairOfSenderPath.nominated).toBe(false);
      expect(
        await Promise.race([
          arrived,
          setTimeout(5_000).then(() => {
            throw new Error("DTLS from the peer's selected path was dropped");
          }),
        ]),
      ).toEqual(["over-the-other-family"]);
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);
});
