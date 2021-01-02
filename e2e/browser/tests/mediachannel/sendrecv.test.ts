import axios from "axios";
import { waitVideoPlay } from "../fixture";

const http = axios.create({ baseURL: "http://localhost:8886" });

describe("mediachannel_sendrecv", () => {
  it(
    "answer",
    async (done) => {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pc.ontrack = ({ track }) => {
        waitVideoPlay(track).then(done);
      };

      const [track] = (
        await navigator.mediaDevices.getUserMedia({ video: true })
      ).getTracks();
      pc.addTrack(track);

      const offer = (await http.post("/mediachannel_sendrecv_answer")).data;
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());

      pc.onicecandidate = ({ candidate }) => {
        http.post("/mediachannel_sendrecv_answer/candidate", candidate);
      };

      http.post("/mediachannel_sendrecv_answer/answer", pc.localDescription);
    },
    10 * 1000
  );
});
