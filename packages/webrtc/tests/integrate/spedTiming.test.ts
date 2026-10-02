import { vi } from "vitest";
import type { Connection } from "../../../ice/src";
import { getConnectionSpedRuntime } from "../../../ice/src/internal/sped-bind";
import {
  DTLS_IN_STUN_ACK,
  DTLS_IN_STUN_DATA,
} from "../../../ice/src/sped/draft00/constants";
import { getRawAttributeValue } from "../../../ice/src/stun/rawAttributeValue";
import { awaitMessage } from "../utils";
import { prepareDelayedAnswerer } from "./spedTimingArrange";

describe("SPED advertisement before DTLS start", () => {
  test.each(["client", "server"] as const)(
    "回答側の DTLS %s 開始が遅れても非対応と誤判定しない",
    async (role) => {
      // Arrange: 候補公開後に gathering の完了を保留し、DTLS 開始を遅らせる。
      const fixture = await prepareDelayedAnswerer(role);
      const { offerer, answerer, outgoing, runtime } = fixture;
      let applying: Promise<unknown> | undefined;
      try {
        // Act: 実 ICE 応答を先に受け、回答側 DTLS が未開始の状態を固定する。
        applying = answerer.setLocalDescription(fixture.answer);
        const response = await fixture.firstResponse;

        // Assert: 空の対応通知だけを返し、未処理の DTLS flight は ACK しない。
        expect(answerer.dtlsTransports[0].state).toBe("new");
        expect(
          getConnectionSpedRuntime(
            answerer.iceTransports[0].connection as Connection,
          ),
        ).toBeUndefined();
        expect(getRawAttributeValue(response, DTLS_IN_STUN_DATA)).toEqual(
          Buffer.alloc(0),
        );
        expect(
          getRawAttributeValue(response, DTLS_IN_STUN_ACK),
        ).toBeUndefined();
        expect(runtime.session.peerSupport).toBe("supported");
        expect(runtime.fallbackStarted).toBe(false);
        if (role === "server") {
          expect(runtime.session.hasL1).toBe(true);
        }

        // Act: gathering を解放し、保持されていた flight で接続を完了する。
        fixture.release();
        await applying;
        const incoming = await fixture.incoming;
        await vi.waitFor(
          () => {
            expect([outgoing.readyState, incoming.readyState]).toEqual([
              "open",
              "open",
            ]);
          },
          { timeout: 5_000 },
        );
        const received = awaitMessage(incoming);
        outgoing.send("after-delayed-DTLS-start");

        // Assert: 実配送後も両端の diagnostics は active/direct で一致する。
        expect(await received).toBe("after-delayed-DTLS-start");
        for (const peer of [offerer, answerer]) {
          const stats = await peer.getStats();
          const transport = [...stats.values()].find(
            (stat) => stat.type === "transport",
          );
          expect(transport).toMatchObject({
            warpSpedState: "active",
            warpCarrier: "direct",
          });
        }
      } finally {
        fixture.restore();
        await applying;
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    15_000,
  );
});
