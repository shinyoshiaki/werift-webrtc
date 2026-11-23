import { existsSync } from "node:fs";

import { DtlsVersion, RTCPeerConnection } from "../../src";
import { waitUntil } from "../utils";
import {
  collectMessages,
  gatheredLocalDescription,
  spawnPionWebrtcSped,
  transportStatsOf,
} from "./warpArrange";

/**
 * werift `sped: true` against a Pion PeerConnection with SPED on
 * (pion/webrtc#3362, built by `tools/pion-webrtc-sped/build.sh`): both ends
 * carry the DTLS 1.3 handshake in ICE Binding, and a DataChannel carries
 * messages both ways, in both offer directions.
 * Opt-in: `npm run test:pion-webrtc-sped` with `WERIFT_PION_WEBRTC_SPED`
 * (path of the built harness). Default `npm test` skips it.
 */
const bin = process.env.WERIFT_PION_WEBRTC_SPED;
if (process.env.WERIFT_PION_WEBRTC_SPED_REQUIRED === "1" && !bin) {
  throw new Error(
    "Pion webrtc SPED opt-in requires WERIFT_PION_WEBRTC_SPED (tools/pion-webrtc-sped/build.sh)",
  );
}
if (bin && !existsSync(bin)) {
  throw new Error(`WERIFT_PION_WEBRTC_SPED does not exist: ${bin}`);
}
const describePion = bin ? describe : describe.skip;

const versionCases = [
  { name: "DTLS 1.3", protocolVersions: [DtlsVersion.V1_3] },
  {
    name: "DTLS [1.3, 1.2]",
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  },
];

const hasSpedOption = (sdp: string | undefined) =>
  /^a=ice-options:(.* )?sped( |$)/m.test(sdp ?? "");

describePion("werift sped: true ↔ Pion SPED (pion/webrtc#3362)", () => {
  test.each(versionCases)(
    "$name: Pion offerer → werift answerer で SPED の DTLS 1.3 handshake と双方向の DataChannel が通る",
    async ({ protocolVersions }) => {
      // Arrange: Pion (SPED) と werift (sped: true)
      const pion = spawnPionWebrtcSped(bin!);
      const werift = new RTCPeerConnection({
        iceServers: [],
        sped: true,
        dtls: { protocolVersions },
      });
      try {
        const opened = new Promise<
          Parameters<NonNullable<typeof werift.ondatachannel>>[0]["channel"]
        >((resolve) => {
          werift.ondatachannel = ({ channel }) => resolve(channel);
        });

        // Act: Pion の offer に werift が answer する
        pion.send({ cmd: "offer" });
        const offer = await pion.next((e) => e.event === "sdp", "offer");
        await werift.setRemoteDescription({ type: "offer", sdp: offer.sdp! });
        await werift.setLocalDescription(await werift.createAnswer());
        const answer = await gatheredLocalDescription(werift);
        pion.send({ cmd: "answer", sdp: answer.sdp });
        const channel = await opened;
        await waitUntil(
          () => channel.readyState === "open",
          "datachannel open",
        );
        await pion.next((e) => e.event === "open", "pion datachannel open");

        // Act: werift → Pion (echo が返る)、Pion → werift
        const received = collectMessages(channel, 2);
        channel.send("from-werift");
        pion.send({ cmd: "send", label: "pion", data: "from-pion" });

        // Assert: 両端が SPED を広告し、双方向に届く
        expect(hasSpedOption(offer.sdp)).toBe(true);
        expect(hasSpedOption(answer.sdp)).toBe(true);
        expect(new Set(await received)).toEqual(
          new Set(["echo:from-werift", "from-pion"]),
        );
        await pion.next(
          (e) => e.event === "message" && e.data === "from-werift",
          "pion received",
        );
        // Assert: werift は SPED で DTLS 1.3 の handshake をした
        const stats = await transportStatsOf(werift);
        expect(stats.tlsVersion).toBe("DTLS 1.3");
        expect(stats.warpSpedState).toBe("active");
      } finally {
        await werift.close();
        await pion.close();
      }
    },
    30_000,
  );

  test.each(versionCases)(
    "$name: werift offerer → Pion answerer で SPED の DTLS 1.3 handshake と双方向の DataChannel が通る",
    async ({ protocolVersions }) => {
      // Arrange: werift (sped: true) と Pion (SPED)
      const pion = spawnPionWebrtcSped(bin!);
      const werift = new RTCPeerConnection({
        iceServers: [],
        sped: true,
        dtls: { protocolVersions },
      });
      try {
        const channel = werift.createDataChannel("werift");

        // Act: werift の offer に Pion が answer する
        await werift.setLocalDescription(await werift.createOffer());
        const offer = await gatheredLocalDescription(werift);
        pion.send({ cmd: "remoteOffer", sdp: offer.sdp });
        const answer = await pion.next((e) => e.event === "sdp", "answer");
        await werift.setRemoteDescription({ type: "answer", sdp: answer.sdp! });
        await waitUntil(
          () => channel.readyState === "open",
          "datachannel open",
        );
        await pion.next((e) => e.event === "open", "pion datachannel open");

        // Act: werift → Pion (echo が返る)、Pion → werift
        const received = collectMessages(channel, 2);
        channel.send("from-werift");
        pion.send({ cmd: "send", label: "werift", data: "from-pion" });

        // Assert: 両端が SPED を広告し、双方向に届く
        expect(hasSpedOption(offer.sdp)).toBe(true);
        expect(hasSpedOption(answer.sdp)).toBe(true);
        expect(new Set(await received)).toEqual(
          new Set(["echo:from-werift", "from-pion"]),
        );
        // Assert: werift は SPED で DTLS 1.3 の handshake をした
        const stats = await transportStatsOf(werift);
        expect(stats.tlsVersion).toBe("DTLS 1.3");
        expect(stats.warpSpedState).toBe("active");
      } finally {
        await werift.close();
        await pion.close();
      }
    },
    30_000,
  );
});
