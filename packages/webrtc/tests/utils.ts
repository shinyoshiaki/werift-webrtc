import { readFileSync } from "fs";
import { RTCDataChannel, RTCPeerConnection } from "../src";

export function load(name: string) {
  return readFileSync("./tests/data/" + name);
}

export async function createDataChannelPair(
  options:
    | Partial<{
        maxPacketLifeTime?: number | undefined;
        protocol: string;
        maxRetransmits?: number | undefined;
        ordered: boolean;
        negotiated: boolean;
        id?: number | undefined;
      }>
    | undefined,
  pc1 = new RTCPeerConnection(),
  pc2 = new RTCPeerConnection()
) {
  let pair: RTCDataChannel[] = [],
    bothOpen: Promise<void[]>;
  try {
    if (options?.negotiated) {
      pair = [pc1, pc2].map((pc) => pc.createDataChannel("", options));
      bothOpen = Promise.all(
        pair.map(
          (dc) =>
            new Promise<void>((r, e) => {
              dc.onopen = r;
              dc.onerror = ({ error }) => e(error);
            })
        )
      );
    } else {
      pair = [pc1.createDataChannel("", options)];
      bothOpen = Promise.all([
        new Promise<void>((r, e) => {
          pair[0].onopen = () => {
            r();
          };
          pair[0].onerror = ({ error }) => e(error);
        }),
        new Promise<void>(
          (r, e) =>
            (pc2.ondatachannel = ({ channel }) => {
              pair[1] = channel;
              channel.onopen = () => {
                r();
              };
              channel.onerror = ({ error }) => e(error);
            })
        ),
      ]);
    }
    exchangeIceCandidates(pc1, pc2);
    await exchangeOfferAnswer(pc1, pc2);
    await bothOpen;
    return pair;
  } finally {
    for (const dc of pair) {
      dc.onopen = dc.onerror = null;
    }
  }
}

function exchangeIceCandidates(pc1: RTCPeerConnection, pc2: RTCPeerConnection) {
  // private function
  function doExchange(localPc: RTCPeerConnection, remotePc: RTCPeerConnection) {
    localPc.onIceCandidate.subscribe((candidate) => {
      if (remotePc.signalingState !== "closed") {
        remotePc.addIceCandidate(candidate.toJSON());
      }
    });
  }

  doExchange(pc1, pc2);
  doExchange(pc2, pc1);
}

async function exchangeOfferAnswer(
  caller: RTCPeerConnection,
  callee: RTCPeerConnection
) {
  await exchangeOffer(caller, callee);
  await exchangeAnswer(caller, callee);
}

async function exchangeOffer(
  caller: RTCPeerConnection,
  callee: RTCPeerConnection
) {
  await caller.setLocalDescription(await caller.createOffer());
  await callee.setRemoteDescription(caller.localDescription!);
}
// Performs an answer exchange caller -> callee.
async function exchangeAnswer(
  caller: RTCPeerConnection,
  callee: RTCPeerConnection
) {
  // Note that caller's remote description must be set first; if not,
  // there's a chance that candidates from callee arrive at caller before
  // it has a remote description to apply them to.
  const answer = await callee.createAnswer();
  await caller.setRemoteDescription(answer);
  await callee.setLocalDescription(answer);
}

export function awaitMessage(channel: RTCDataChannel) {
  return new Promise<string | Buffer>((resolve, reject) => {
    Promise.all([
      new Promise<any>((r) =>
        channel.addEventListener("message", (e) => {
          r(e.data);
        })
      ),
      channel.message.asPromise(),
    ]).then(([msg]) => resolve(msg));

    channel.error.once(reject);
  });
}
