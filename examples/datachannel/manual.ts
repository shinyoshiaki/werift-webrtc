import { RTCPeerConnection } from "../../packages/webrtc/src";
console.log("start");

(async () => {
  const data = process.argv[2];
  console.log(data);
  const offer = JSON.parse(data as string);
  console.log(offer);

  const pc = new RTCPeerConnection({});
  await pc.setRemoteDescription(offer);
  const answer = pc.createAnswer()!;
  await pc.setLocalDescription(await answer);
  console.log(JSON.stringify(answer));

  pc.onDataChannel.subscribe((channel) => {
    channel.onMessage.subscribe((data) => {
      console.log("answer message", data.toString());
      setInterval(() => channel.send(Buffer.from("pong")), 1000);
    });
  });
})();
