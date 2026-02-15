import * as Werift from "../packages/webrtc/src";

const ITERATIONS = Number(process.env.ISSUE540_COUNT ?? "100");
const FORCED_SACK_DELAY_MS = Number(process.env.ISSUE540_SACK_DELAY_MS ?? "200");

async function connectPeers() {
  const peer1 = new Werift.RTCPeerConnection({});
  const peer2 = new Werift.RTCPeerConnection({});

  peer1.onicecandidate = ({ candidate }) => candidate && peer2.addIceCandidate(candidate);
  peer2.onicecandidate = ({ candidate }) => candidate && peer1.addIceCandidate(candidate);

  const dc1 = peer1.createDataChannel("issue540");

  peer2.onDataChannel.subscribe((channel) => {
    channel.onMessage.subscribe((msg) => channel.send(msg));
  });

  const offer = await peer1.createOffer();
  await peer1.setLocalDescription(offer);
  await peer2.setRemoteDescription(peer1.localDescription!);
  const answer = await peer2.createAnswer();
  await peer2.setLocalDescription(answer);
  await peer1.setRemoteDescription(peer2.localDescription!);

  await new Promise<void>((resolve) => {
    dc1.stateChanged.subscribe((state) => state === "open" && resolve());
  });

  return { peer1, peer2, dc1 };
}

function patchReceiverSack(peer2: Werift.RTCPeerConnection) {
  if (FORCED_SACK_DELAY_MS <= 0) return;
  const sctp = peer2.sctpTransport?.sctp as any;
  if (!sctp?.sendSack) return;

  const original = sctp.sendSack.bind(sctp);
  sctp.sendSack = async (...args: unknown[]) => {
    await new Promise<void>((resolve) => setTimeout(resolve, FORCED_SACK_DELAY_MS));
    return original(...args);
  };
}

async function run() {
  const { peer1, peer2, dc1 } = await connectPeers();
  patchReceiverSack(peer2);

  const sentAt: number[] = [];
  const gaps: number[] = [];
  let received = 0;
  const started = performance.now();

  await new Promise<void>((resolve) => {
    dc1.onMessage.subscribe(() => {
      const now = performance.now();
      gaps.push(now - sentAt[received]);
      received++;
      if (received >= ITERATIONS) {
        resolve();
        return;
      }
      sentAt.push(performance.now());
      dc1.send(`msg-${received}`);
    });

    sentAt.push(performance.now());
    dc1.send("msg-0");
  });

  const total = performance.now() - started;
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const maxGap = Math.max(...gaps);
  const minGap = Math.min(...gaps);

  console.log(
    `RESULT recv=${received} total_ms=${total.toFixed(1)} avg_gap_ms=${avgGap.toFixed(2)} min_gap_ms=${minGap.toFixed(2)} max_gap_ms=${maxGap.toFixed(2)} forced_sack_delay_ms=${FORCED_SACK_DELAY_MS}`,
  );

  dc1.close();
  peer1.close();
  peer2.close();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
