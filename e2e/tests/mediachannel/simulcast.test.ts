import { waitVideoPlay, peer, sleep } from "../fixture";

describe("mediachannel_simulcast", () => {
  it(
    "answer",
    async () =>
      new Promise<void>(async (done) => {
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });

        let count = 0;
        const finish = () => {
          if (++count == 2) done();
        };
        pc.ontrack = ({ track }) => {
          waitVideoPlay(track).then(finish);
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

        const offer = await peer.request("mediachannel_simulcast_answer", {
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
          peer.request("mediachannel_simulcast_answer", {
            type: "candidate",
            payload: candidate,
          });
        };

        peer.request("mediachannel_simulcast_answer", {
          type: "answer",
          payload: pc.localDescription,
        });
      }),
    10 * 1000
  );

  it(
    "offer",
    async () =>
      new Promise<void>(async (done) => {
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });

        let count = 0;
        const finish = () => {
          if (++count == 2) done();
        };
        pc.ontrack = ({ track }) => {
          waitVideoPlay(track).then(finish);
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
          peer.request("mediachannel_simulcast_offer", {
            type: "candidate",
            payload: candidate,
          });
        };

        await pc.setLocalDescription(await pc.createOffer());
        const answer = await peer.request("mediachannel_simulcast_offer", {
          type: "init",
          payload: pc.localDescription,
        });
        await pc.setRemoteDescription(answer);
      }),
    10 * 1000
  );
});
