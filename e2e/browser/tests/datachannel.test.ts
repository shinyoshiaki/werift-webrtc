import axios from "axios";

const http = axios.create({ baseURL: "http://localhost:8886" });

describe("datachannel", () => {
  it(
    "answer",
    async (done) => {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      const offer = (await http.post("/datachannel_answer")).data;
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());

      pc.ondatachannel = ({ channel }) => {
        channel.send("ping");
        channel.onmessage = ({ data }) => {
          expect(data).toBe("ping" + "pong");
          console.warn("answer", "succeed");
          done();
        };
      };

      pc.onicecandidate = ({ candidate }) => {
        http.post("/datachannel_answer/candidate", candidate);
      };

      http.post("/datachannel_answer/answer", pc.localDescription);
    },
    10 * 1000
  );

  it(
    "offer",
    async (done) => {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      const channel = pc.createDataChannel("dc");
      channel.onopen = () => {
        channel.send("ping");
      };
      channel.onmessage = ({ data }) => {
        expect(data).toBe("ping" + "pong");
        console.warn("offer", "succeed");
        done();
      };
      pc.onicecandidate = ({ candidate }) => {
        http.post("/datachannel_offer/candidate", candidate);
      };

      await pc.setLocalDescription(await pc.createOffer());
      const answer = (
        await http.post("/datachannel_offer", pc.localDescription)
      ).data;
      await pc.setRemoteDescription(answer);
    },
    10 * 1000
  );
});
