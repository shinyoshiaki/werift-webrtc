import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  canBindAddress,
  createSelectiveStunServer,
  fakeNetworkInterfaces,
} from "../../../ice/tests/utils";
import { RTCPeerConnection } from "../../src";

// 疑似 NIC と既定経路: テストごとに差し替える
const env = vi.hoisted(() => ({
  nics: undefined as Record<string, unknown> | undefined,
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    networkInterfaces: () => env.nics ?? actual.networkInterfaces(),
  };
});
vi.mock("../../../ice/src/internal/defaultRoute", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../ice/src/internal/defaultRoute")
    >();
  return { ...actual, getDefaultRouteAddresses: async () => [] };
});

describe("ICE gathering on a multi-NIC host", () => {
  beforeEach(async (context) => {
    if (!(await canBindAddress("127.0.0.2"))) {
      context.skip();
    }
  });
  afterEach(() => {
    env.nics = undefined;
  });

  test("setLocalDescription does not wait for a NIC that cannot reach STUN; its end-of-candidates follows the trickled candidates", async () => {
    // Arrange: eth1 (127.0.0.2) からは STUN に届かない疑似マルチ NIC
    env.nics = fakeNetworkInterfaces({
      eth0: ["127.0.0.1"],
      eth1: ["127.0.0.2"],
    });
    const stun = await createSelectiveStunServer("127.0.0.1", ["127.0.0.2"]);
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: `stun:${stun.address[0]}:${stun.address[1]}` }],
      iceUseIpv6: false,
      iceStunGatherTimeout: 2,
    });
    const events: ({ candidate: string } | null)[] = [];
    const ended = new Promise<void>((resolve) => {
      pc.onicecandidate = ({ candidate }) => {
        events.push(candidate ? { candidate: candidate.candidate } : null);
        if (!candidate) resolve();
      };
    });

    try {
      pc.createDataChannel("multi-nic");

      // Act: offer を作って setLocalDescription する
      const started = Date.now();
      await pc.setLocalDescription(await pc.createOffer());
      const applied = Date.now() - started;

      // Assert: 届かない NIC の timeout を待たずに返り、gathering はまだ続く
      expect(applied).toBeLessThan(1500);
      expect(pc.iceGatheringState).toBe("gathering");
      expect(pc.localDescription!.sdp).toContain("raddr 0.0.0.0");
      expect(pc.localDescription!.sdp).not.toContain("a=end-of-candidates");

      // Act: end-of-candidates を待つ
      await ended;

      // Assert: 届く NIC の srflx が trickle された後に null が届き、complete になる
      const trickled = events.filter((event) =>
        event?.candidate.includes("typ srflx raddr 127.0.0.1"),
      );
      expect(trickled).toHaveLength(1);
      expect(events.at(-1)).toBeNull();
      expect(events.filter((event) => event === null)).toHaveLength(1);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      expect(pc.iceGatheringState).toBe("complete");
      expect(pc.localDescription!.sdp).toContain("a=end-of-candidates");
      expect(pc.localDescription!.sdp).toContain("raddr 127.0.0.1");
    } finally {
      await pc.close();
      await stun.close();
    }
  });
});
