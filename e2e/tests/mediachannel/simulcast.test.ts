import { peer, sleep, waitVideoPlay } from "../fixture";

describe("mediachannel_simulcast", () => {
  it("mediachannel_simulcast_answer", async () =>
    new Promise<void>(async (done, fail) => {
      const label = "mediachannel_simulcast_answer";
      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      let count = 0;
      const finish = () => {
        if (++count === 2) {
          pc.close();
          done();
        }
      };
      pc.ontrack = async ({ track }) => {
        try {
          // Act: 折り返し rid レイヤの映像が再生されるまで待つ
          await waitVideoPlay(track);
          // Assert: high / low の 2 レイヤが揃ってから close する
          finish();
        } catch (error) {
          fail(error);
        }
      };

      const [track] = (
        await navigator.mediaDevices.getUserMedia({ video: true })
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
    }));

  it("mediachannel_simulcast_offer", async () =>
    new Promise<void>(async (done, fail) => {
      const label = "mediachannel_simulcast_offer";
      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      let count = 0;
      const finish = () => {
        if (++count === 2) {
          pc.close();
          done();
        }
      };
      pc.ontrack = async ({ track }) => {
        try {
          // Act: offerer 側で折り返し rid レイヤの再生を待つ
          await waitVideoPlay(track);
          // Assert: 2 レイヤ到達後にだけ PC を閉じる
          finish();
        } catch (error) {
          fail(error);
        }
      };

      const [track] = (
        await navigator.mediaDevices.getUserMedia({ video: true })
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
    }));
});
