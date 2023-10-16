import React, { FC, useRef } from "react";
import ReactDOM from "react-dom";
import { getVideoStreamFromFile } from "../../util";

const peer = new RTCPeerConnection({
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
});

const App: FC = () => {
  const videoRef = useRef<HTMLVideoElement>();

  const onFile = async (file: File) => {
    const socket = new WebSocket("ws://localhost:8878");
    await new Promise((r) => (socket.onopen = r));
    console.log("open websocket");

    const offer = await new Promise<any>(
      (r) => (socket.onmessage = (ev) => r(JSON.parse(ev.data)))
    );
    console.log("offer", offer.sdp);

    peer.onicecandidate = ({ candidate }) => {
      socket.send(JSON.stringify({ candidate }));
    };
    const stream = new MediaStream();
    peer.ontrack = (e) => {
      console.log("ontrack", e);
      stream.addTrack(e.track);
      videoRef.current.srcObject = stream;
    };

    const res = await getVideoStreamFromFile(file);
    const [video] = res.getVideoTracks();
    const [audio] = res.getAudioTracks();
    peer.addTrack(video);
    peer.addTrack(audio);

    await peer.setRemoteDescription(offer);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    const sdp = JSON.stringify(peer.localDescription);
    socket.send(sdp);
  };

  return (
    <div>
      <input type="file" onChange={(e) => onFile(e.target.files[0])} />
      <video autoPlay ref={videoRef} width={100} height={100} />
    </div>
  );
};

ReactDOM.render(<App />, document.getElementById("root"));
