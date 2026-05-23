import { PassThrough } from "node:stream";

import { describe, expect, test } from "vitest";

import { FrontProxyLoadBalancer } from "../src/lb";
import type {
  RelayAttachment,
  RelayEndpoint,
  RelayEnvelope,
} from "../src/types";
import { createContext, readTestTlsOptions } from "./fixture";

describe("FrontProxyLoadBalancer relay failover", () => {
  test("reselects another relay when the relay envelope is lost", async () => {
    const context = createContext();
    const relay1 = new RecordingRelay("relay-1", true);
    const relay2 = new RecordingRelay("relay-2");
    const lb = new FrontProxyLoadBalancer({
      host: "127.0.0.1",
      port: 0,
      publicTurnAddress: context.publicTurnAddress,
      tls: readTestTlsOptions(),
      relays: [relay1, relay2],
      random: () => 0,
    });
    const stream = new PassThrough();

    try {
      // Act: 最初の relay が内部 envelope loss を通知したら、LB は failed relay を除外して再選択する。
      lb.routeEnvelopeForTest(stream, context);
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Assert: 同じ client stream を閉じずに relay-2 へ付け替え、relay-1 からは detach している。
      expect(relay1.acceptCount).toBe(1);
      expect(relay1.detachCount).toBe(1);
      expect(relay2.acceptCount).toBe(1);
      expect(relay2.lastClientTransportKey).toBe(
        "203.0.113.10:53124|34.120.1.10:443|tcp",
      );
      expect(stream.destroyed).toBe(false);
    } finally {
      stream.destroy();
      await lb.close();
    }
  });
});

class RecordingRelay implements RelayEndpoint {
  acceptCount = 0;
  detachCount = 0;
  lastClientTransportKey?: string;

  constructor(
    readonly id: string,
    private readonly failOnFirstAccept = false,
  ) {}

  acceptEnvelope(envelope: RelayEnvelope): RelayAttachment {
    this.acceptCount += 1;
    const clientTransportKey = [
      `${envelope.context.originalClientAddress.ip}:${envelope.context.originalClientAddress.port}`,
      `${envelope.context.publicTurnAddress.ip}:${envelope.context.publicTurnAddress.port}`,
      envelope.context.publicTurnAddress.transport,
    ].join("|");
    this.lastClientTransportKey = clientTransportKey;

    if (this.failOnFirstAccept && this.acceptCount === 1) {
      queueMicrotask(() => {
        envelope.reportRelayFailure(new Error("relay envelope lost"));
      });
    }

    return {
      relayId: this.id,
      clientTransportKey,
      close: () => {
        envelope.stream.destroy();
      },
      detach: () => {
        this.detachCount += 1;
      },
    };
  }
}
