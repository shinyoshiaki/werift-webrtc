import {
  advertiseRenomination,
  ensurePeerConnected,
  getSelectedCandidatePairAddresses,
  holdBackNonRelayCandidates,
  peer,
  sleep,
  waitForDataChannelOpen,
  waitForIceGatheringComplete,
} from "../fixture";

const label = "ice_nomination";

type NominationStats = {
  connectionState: string;
  controlling: boolean;
  remoteRenomination: boolean;
  nominated?: {
    localCandidateType: string;
    remoteAddress: string;
    remotePort: number;
    nomination: number;
    remoteNomination: number;
  };
  useCandidateReceived: number;
  nominationsReceived: number[];
};

const serverStats = () =>
  peer.request(label, {
    type: "stats",
    payload: {},
  }) as Promise<NominationStats>;

/**
 * Arrange: connect Chrome and werift so that the first selected path is
 * werift's TURN relay (werift only checks relay pairs and the browser holds
 * back werift's host candidates). `offerer` decides the ICE roles: the
 * offerer is controlling. With `renomination` both descriptions advertise
 * `a=ice-options:renomination` (Chrome's after modifying it).
 */
async function connectOverRelayFirst({
  offerer,
  renomination,
}: {
  offerer: "chrome" | "werift";
  renomination: boolean;
}) {
  await ensurePeerConnected();
  await sleep(100);
  const pc = new RTCPeerConnection();
  const local = (sdp: string) =>
    renomination ? advertiseRenomination(sdp) : sdp;
  let channel: RTCDataChannel;
  let held: string[];

  if (offerer === "chrome") {
    channel = pc.createDataChannel("nomination");
    const offer = await pc.createOffer();
    await pc.setLocalDescription({ type: "offer", sdp: local(offer.sdp!) });
    await waitForIceGatheringComplete(pc);
    const answer = await peer.request(label, {
      type: "init",
      payload: { renomination, offer: pc.localDescription },
    });
    const remote = holdBackNonRelayCandidates(answer.sdp);
    held = remote.held;
    await pc.setRemoteDescription({ type: "answer", sdp: remote.sdp });
  } else {
    const opened = new Promise<RTCDataChannel>((resolve) => {
      pc.ondatachannel = ({ channel }) => resolve(channel);
    });
    const offer = await peer.request(label, {
      type: "init",
      payload: { renomination },
    });
    const remote = holdBackNonRelayCandidates(offer.sdp);
    held = remote.held;
    await pc.setRemoteDescription({ type: "offer", sdp: remote.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription({ type: "answer", sdp: local(answer.sdp!) });
    await waitForIceGatheringComplete(pc);
    await peer.request(label, { type: "answer", payload: pc.localDescription });
    channel = await opened;
  }
  await waitForDataChannelOpen(channel);
  return { pc, channel, held };
}

/** Send `text` and wait for werift's echo, ignoring werift's own messages. */
async function roundTrip(channel: RTCDataChannel, text: string) {
  const echoed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no echo of "${text}"`)),
      10_000,
    );
    const onMessage = ({ data }: MessageEvent) => {
      if (data !== `${text}pong`) return;
      clearTimeout(timer);
      channel.removeEventListener("message", onMessage);
      resolve();
    };
    channel.addEventListener("message", onMessage);
  });
  channel.send(text);
  await echoed;
}

/** Signal werift's held-back host candidates to Chrome. */
async function signalHeldCandidates(pc: RTCPeerConnection, held: string[]) {
  for (const candidate of held) {
    await pc.addIceCandidate({ candidate, sdpMid: "0", sdpMLineIndex: 0 });
  }
}

/** Wait until both ends selected one host <-> host path; werift keeps sending meanwhile. */
async function waitForHostPath(pc: RTCPeerConnection) {
  return vi.waitFor(
    async () => {
      await peer.request(label, { type: "send", payload: {} });
      const chrome = await getSelectedCandidatePairAddresses(pc);
      const werift = await serverStats();
      expect(werift.nominated?.localCandidateType).toBe("host");
      expect(chrome.remoteCandidateType).toBe("host");
      // The same 5-tuple seen from both ends.
      expect(werift.nominated?.remoteAddress).toBe(chrome.localAddress);
      expect(werift.nominated?.remotePort).toBe(chrome.localPort);
      return { chrome, werift };
    },
    { timeout: 15_000, interval: 250 },
  );
}

describe("ice/nomination (semi-aggressive / renomination with Chrome)", () => {
  test.each([
    { offerer: "chrome", renomination: false },
    { offerer: "chrome", renomination: true },
    { offerer: "werift", renomination: false },
    { offerer: "werift", renomination: true },
  ] as const)(
    "the selection moves from the relay path to the host path ($offerer offers, renomination: $renomination)",
    async ({ offerer, renomination }) => {
      const { pc, channel, held } = await connectOverRelayFirst({
        offerer,
        renomination,
      });

      try {
        // Assert: 最初は relay の経路が両端で選択され、データが届く。
        const before = await serverStats();
        expect(before.controlling).toBe(offerer === "werift");
        expect(before.nominated?.localCandidateType).toBe("relay");
        expect(
          (await getSelectedCandidatePairAddresses(pc)).remoteCandidateType,
        ).toBe("relay");
        await roundTrip(channel, "relay-first");

        // Act: 保留していた werift の host 候補を Chrome に通知する。
        await signalHeldCandidates(pc, held);

        // Assert: 両端の選択が同じ host <-> host の経路に移り、データが届く。
        const { werift } = await waitForHostPath(pc);
        await roundTrip(channel, "host-later");

        // Assert: renomination の交渉結果どおりの方式で指名される。
        expect(werift.remoteRenomination).toBe(renomination);
        if (offerer === "chrome") {
          // Chrome (controlling) の指名に werift (controlled) が従う。
          if (renomination) {
            // NOMINATION の値を増やして再指名し、USE-CANDIDATE は使わない。
            expect(werift.useCandidateReceived).toBe(0);
            expect(Math.max(...werift.nominationsReceived)).toBeGreaterThan(1);
            expect(werift.nominated?.remoteNomination).toBe(
              Math.max(...werift.nominationsReceived),
            );
          } else {
            // semi-aggressive: より良い経路への USE-CANDIDATE で切り替わる。
            expect(werift.nominationsReceived).toEqual([]);
            expect(werift.useCandidateReceived).toBeGreaterThan(0);
            expect(werift.nominated?.remoteNomination).toBe(1);
          }
        } else {
          // werift (controlling) の指名に Chrome (controlled) が従う。
          // renomination なら werift が送り Chrome が応答した NOMINATION は 2 以上 (relay の 1 の次)。
          if (renomination) {
            expect(werift.nominated?.nomination).toBeGreaterThan(1);
          } else {
            expect(werift.nominated?.nomination).toBe(0);
          }
        }
      } finally {
        await peer
          .request(label, { type: "close", payload: {} })
          .catch(() => {});
        pc.close();
      }
    },
  );
});
