/* eslint-disable @typescript-eslint/ban-ts-comment */
import React, { FC, useEffect } from "react";
import ReactDOM from "react-dom";
import "buffer";
import { uint16Add } from "../../../packages/common/src";
import { RtpHeader, RtpPacket } from "../../../packages/rtp/src";

let sequenceNumber = 0;
const socket = new WebSocket("ws://localhost:8889");

const senderTransform = (sender: RTCRtpSender) => {
  const senderStreams = (sender as any).createEncodedStreams();
  const readableStream = senderStreams.readable;
  const writableStream = senderStreams.writable;
  const transformStream = new TransformStream({
    transform: (encodedFrame, controller) => {
      if (encodedFrame.data.byteLength > 0) {
        const metadata = encodedFrame.getMetadata();
        const { synchronizationSource } = metadata;
        console.log(JSON.parse(JSON.stringify(metadata)), encodedFrame);

        sequenceNumber = uint16Add(sequenceNumber, 1);
        const rtp = new RtpPacket(
          new RtpHeader({
            timestamp: encodedFrame.timestamp,
            payloadType: 0,
            ssrc: synchronizationSource,
            sequenceNumber,
            marker: encodedFrame.type === "key",
          }),
          Buffer.from(encodedFrame.data)
        );
        try {
          socket.send(rtp.serialize());
        } catch (error) {
          console.log(error);
        }
      }
      controller.enqueue(encodedFrame);
    },
  });
  readableStream.pipeThrough(transformStream).pipeTo(writableStream);
};

const peer = new RTCPeerConnection({
  //@ts-ignore
  encodedInsertableStreams: true,
  iceServers: [],
});

const App: FC = () => {
  useEffect(() => {
    (async () => {
      const socket = new WebSocket("ws://127.0.0.1:8888");
      await new Promise((r) => (socket.onopen = r));
      console.log("open websocket");

      const offer = await new Promise<any>(
        (r) => (socket.onmessage = (ev) => r(JSON.parse(ev.data)))
      );
      console.log("offer", offer.sdp);

      peer.onicecandidate = ({ candidate }) => {
        if (!candidate) {
          const sdp = JSON.stringify(peer.localDescription);
          console.log("answer", peer.localDescription.sdp);
          socket.send(sdp);
        }
      };

      const [track] = (
        await navigator.mediaDevices.getUserMedia({ video: true })
      ).getTracks();
      const sender = peer.addTrack(track);
      senderTransform(sender);

      await peer.setRemoteDescription(offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
    })();
  }, []);

  return <div></div>;
};

ReactDOM.render(<App />, document.getElementById("root"));
