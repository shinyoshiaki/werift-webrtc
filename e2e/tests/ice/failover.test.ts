import {
  advertiseRenomination,
  ensurePeerConnected,
  firefoxUnsupported,
  getSelectedCandidatePairAddresses,
  isFirefox,
  itSkipOnFirefox,
  peer,
  sleep,
  waitForDataChannelOpen,
  waitForIceGatheringComplete,
} from "../fixture";

const label = "ice_failover";

type FailoverStats = {
  connectionState: string;
  iceConnectionState: string;
  controlling: boolean;
  remoteRenomination: boolean;
  generation: number;
  nominated?: {
    localCandidateType: string;
    remoteAddress: string;
    remotePort: number;
  };
  states: string[];
};

const serverStats = () =>
  peer.request(label, {
    type: "stats",
    payload: {},
  }) as Promise<FailoverStats>;

/**
 * Arrange: werift offers (controlling) with host and TURN relay candidates,
 * Chrome answers (controlled) and both select the host path.
 */
async function connectOverHost(renomination: boolean) {
  await ensurePeerConnected();
  await sleep(100);
  const pc = new RTCPeerConnection();
  const opened = new Promise<RTCDataChannel>((resolve) => {
    pc.ondatachannel = ({ channel }) => resolve(channel);
  });
  const offer = await peer.request(label, {
    type: "init",
    payload: { renomination },
  });
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription({
    type: "answer",
    sdp: renomination ? advertiseRenomination(answer.sdp!) : answer.sdp,
  });
  await waitForIceGatheringComplete(pc);
  await peer.request(label, { type: "answer", payload: pc.localDescription });
  const channel = await opened;
  await waitForDataChannelOpen(channel);
  await vi.waitFor(
    async () => {
      const werift = await serverStats();
      expect(werift.nominated?.localCandidateType).toBe("host");
      expect(
        (await getSelectedCandidatePairAddresses(pc)).remoteCandidateType,
      ).toBe("host");
    },
    { timeout: 15_000, interval: 250 },
  );
  return { pc, channel };
}

/** Send `text` and wait for werift's echo. */
async function roundTrip(
  channel: RTCDataChannel,
  text: string,
  timeout = 10_000,
) {
  const echoed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no echo of "${text}"`)),
      timeout,
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

describe("ice/failover (werift controlling, Chrome controlled)", () => {
  for (const renomination of [false, true]) {
    const itCase = renomination
      ? itSkipOnFirefox(firefoxUnsupported.renomination)
      : it;
    itCase(
      `werift's host sockets are cut: werift fails over to its relay pair without an ICE restart and Chrome follows (renomination: ${renomination})`,
      async ({ annotate }) => {
        const { pc, channel } = await connectOverHost(renomination);
        await roundTrip(channel, "host");
        const before = await serverStats();
        expect(before.controlling).toBe(true);

        try {
          // Act: werift の host ソケットを遮断する (送受信とも届かない)。
          await peer.request(label, { type: "cut", payload: {} });

          // Assert: werift は ICE restart なしで relay の pair に退避する。
          await vi.waitFor(
            async () => {
              const werift = await serverStats();
              expect(werift.nominated?.localCandidateType).toBe("relay");
            },
            { timeout: 20_000, interval: 250 },
          );
          if (isFirefox) {
            // Firefox は優先度の低い relay ペアへの指名に追従しないので、ブラウザ側の
            // 追従と relay での往復は確かめない (firefoxUnsupported.lowerPriorityNomination)。
            await annotate(firefoxUnsupported.lowerPriorityNomination);
          } else {
            // Act: werift が relay の経路でデータを送る (Chrome は指名とデータに従う)。
            await peer.request(label, { type: "send", payload: {} });

            // Assert: Chrome も werift の relay 候補を使う経路に移り、データが往復する。
            await vi.waitFor(
              async () => {
                await peer.request(label, { type: "send", payload: {} });
                expect(
                  (await getSelectedCandidatePairAddresses(pc))
                    .remoteCandidateType,
                ).toBe("relay");
              },
              { timeout: 15_000, interval: 250 },
            );
            await roundTrip(channel, "relay");
          }
          // Assert: どのブラウザでも ICE restart はしておらず、werift は connected のまま。
          const after = await serverStats();
          expect(after.generation).toBe(before.generation);
          expect(after.iceConnectionState).toBe("connected");
          expect(after.connectionState).toBe("connected");
        } finally {
          await peer
            .request(label, { type: "close", payload: {} })
            .catch(() => {});
          pc.close();
        }
      },
      60_000,
    );
  }
});
