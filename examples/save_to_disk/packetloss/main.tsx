import React, { type FC, useRef } from "react";
import ReactDOM from "react-dom";
import { createRoot } from "react-dom/client";
import { getVideoStream } from "../../util";

const peer = new RTCPeerConnection({});

const App: FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);

  const onFile = async (file: File) => {
    const socket = new WebSocket("ws://127.0.0.1:8888");
    await new Promise((r) => (socket.onopen = r));
    console.log("open websocket");

    const offer = await new Promise<any>(
      (r) => (socket.onmessage = (ev) => r(JSON.parse(ev.data))),
    );
    console.log("offer", offer.sdp);

    peer.onicecandidate = ({ candidate }) => {
      if (!candidate) {
        const sdp = JSON.stringify(peer.localDescription);
        console.log("answer", peer.localDescription.sdp);
        socket.send(sdp);
      }
    };
    peer.ontrack = (e) => {
      switch (e.track.kind) {
        case "video":
          videoRef.current.srcObject = e.streams[0];
          break;
      }
    };

    const stream = await getVideoStream(await file.arrayBuffer());
    const [track] = stream.getTracks();
    peer.addTrack(track);

    await peer.setRemoteDescription(offer);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
  };

  return (
    <div>
      <input type="file" onChange={(e) => onFile(e.target.files[0])} />
      <video autoPlay ref={videoRef} width={100} height={100} />
    </div>
  );
};

const container = document.getElementById("root");
const root = createRoot(container!);
root.render(<App />);
