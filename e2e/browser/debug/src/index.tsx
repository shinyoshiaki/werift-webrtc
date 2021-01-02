import { waitVideoPlay } from "../../tests/fixture";
import axios from "axios";

const http = axios.create({ baseURL: "https://127.0.0.1:8886" });

(async () => {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  pc.ontrack = ({ track }) => {
    waitVideoPlay(track);
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
})();
