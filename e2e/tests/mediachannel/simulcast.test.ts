import { waitVideoPlay, peer, sleep } from "../fixture";

describe("mediachannel_simulcast", () => {
  it(
    "mediachannel_simulcast_answer",
    async () =>
      new Promise<void>(async (done) => {
        const label = "mediachannel_simulcast_answer";
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });

        let count = 0;
        const finish = () => {
          if (++count == 2) {
            pc.close();
            done();
          }
        };
        pc.ontrack = async ({ track }) => {
          await new Promise((r) => setTimeout(r, 2000));
          await waitVideoPlay(track);
          pc.close();

          finish();
        };

        const [track] = (
          await navigator.mediaDevices.getUserMedia({
            video: {
              width: {
                ideal: 4096,
              },
              height: {
                ideal: 2160,
              },
              frameRate: {
                ideal: 60,
                min: 10,
              },
            },
            audio: false,
          })
        ).getTracks();

        const offer = await peer.request(label, {
          type: "init",
        });
        await pc.setRemoteDescription(offer);
        pc.addTrack(track);
        const transceiver = pc.getTransceivers()[0];
        const params = transceiver.sender.getParameters();
        params.encodings = [
          {
            rid: "high",
            maxBitrate: 200000,
            scaleResolutionDownBy: 1,
          },
          {
            rid: "low",
            maxBitrate: 100000 / 4,
            scaleResolutionDownBy: 4,
          },
        ];
        transceiver.sender.setParameters(params);
        await pc.setLocalDescription(await pc.createAnswer());

        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(label, {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        };

        peer
          .request(label, {
            type: "answer",
            payload: pc.localDescription,
          })
          .catch(() => {});
      }),
    15_000
  );

  it(
    "mediachannel_simulcast_offer",
    async () =>
      new Promise<void>(async (done) => {
        const label = "mediachannel_simulcast_offer";
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });

        let count = 0;
        const finish = () => {
          if (++count == 2) {
            pc.close();
            done();
          }
        };
        pc.ontrack = async ({ track }) => {
          await new Promise((r) => setTimeout(r, 2000));
          await waitVideoPlay(track);
          pc.close();

          finish();
        };

        const [track] = (
          await navigator.mediaDevices.getUserMedia({
            video: {
              width: {
                ideal: 4096,
              },
              height: {
                ideal: 2160,
              },
              frameRate: {
                ideal: 60,
                min: 10,
              },
            },
            audio: false,
          })
        ).getTracks();

        pc.addTransceiver(track, {
          direction: "sendonly",
          sendEncodings: [
            {
              rid: "high",
              maxBitrate: 200000,
              scaleResolutionDownBy: 1,
            },
            {
              rid: "low",
              maxBitrate: 100000 / 4,
              scaleResolutionDownBy: 4,
            },
          ],
        });
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(label, {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        };

        await pc.setLocalDescription(await pc.createOffer());
        const answer = await peer.request(label, {
          type: "init",
          payload: pc.localDescription,
        });
        await pc.setRemoteDescription(answer);
      }),
    15_000
  );
});
