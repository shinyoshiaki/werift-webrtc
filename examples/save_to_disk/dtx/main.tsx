import React, { FC } from "react";
import ReactDOM from "react-dom";
import * as sdpTransform from "sdp-transform";
import { getVideoStreamFromFile } from "../../util";

const peer = new RTCPeerConnection({});

const App: FC = () => {
  const onFile = async (file: File) => {
    const socket = new WebSocket("ws://localhost:8878");
    await new Promise((r) => (socket.onopen = r));
    console.log("open websocket");

    const offer = await new Promise<any>(
      (r) => (socket.onmessage = (ev) => r(JSON.parse(ev.data)))
    );
    console.log("offer", offer);

    peer.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socket.send(JSON.stringify(candidate));
      }
    };

    const stream = await getVideoStreamFromFile(file);
    const [video] = stream.getVideoTracks();
    peer.addTrack(video);
    const [audio] = stream.getAudioTracks();
    peer.addTrack(audio);

    await peer.setRemoteDescription(offer);

    const answer = await peer.createAnswer();
    const sdpO = sdpTransform.parse(answer.sdp);
    sdpO.media[0].fmtp[0].config += ";usedtx=1";
    const sdp = sdpTransform.write(sdpO);
    await peer.setLocalDescription({ sdp, type: "answer" });

    socket.send(JSON.stringify(peer.localDescription));
  };

  return (
    <div>
      <input type="file" onChange={(e) => onFile(e.target.files[0])} />
    </div>
  );
};

ReactDOM.render(<App />, document.getElementById("root"));
