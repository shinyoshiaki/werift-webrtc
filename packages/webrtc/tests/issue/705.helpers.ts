import {
  type RTCIceCandidate,
  RTCPeerConnection,
  type RTCPeerConnectionConfig,
  SessionDescription,
  useOPUS,
} from "../../src";

export type MediaKind = "audio" | "video";

export function createAudioOnlyPeerConnection(
  config: RTCPeerConnectionConfig = {},
) {
  return new RTCPeerConnection({
    iceServers: [],
    ...config,
    codecs: { audio: [useOPUS()], video: [] },
  });
}

export async function createOfferWithKinds(
  kinds: MediaKind[],
  config: RTCPeerConnectionConfig = {},
) {
  const pc = new RTCPeerConnection({
    iceServers: [],
    ...config,
  });
  for (const kind of kinds) {
    pc.addTransceiver(kind, { direction: "sendonly" });
  }
  const offer = await pc.createOffer();
  return { pc, offer };
}

export function parseSdp(sdp: string | undefined) {
  if (!sdp) {
    throw new Error("sdp is empty");
  }
  return SessionDescription.parse(sdp);
}

export function getBundleItems(description: SessionDescription) {
  return description.group.find((group) => group.semantic === "BUNDLE")?.items;
}

export function findMedia(description: SessionDescription, kind: MediaKind) {
  return description.media.find((media) => media.kind === kind);
}

export function replaceMLinePort(
  sdp: string | undefined,
  kind: MediaKind,
  port: number,
) {
  if (!sdp) {
    throw new Error("sdp is empty");
  }
  return sdp.replace(new RegExp(`m=${kind} \\d+`), `m=${kind} ${port}`);
}

export function replaceMediaProfile(
  sdp: string | undefined,
  from: string,
  to: string,
) {
  if (!sdp) {
    throw new Error("sdp is empty");
  }
  return sdp.replaceAll(from, to);
}

export function replaceMediaDirection(
  sdp: string | undefined,
  mid: string,
  direction: "sendonly" | "recvonly" | "sendrecv" | "inactive",
) {
  if (!sdp) {
    throw new Error("sdp is empty");
  }
  return sdp
    .split(/\r\n(?=m=)/)
    .map((section) =>
      section.includes(`a=mid:${mid}\r\n`)
        ? section.replace(
            /a=(sendonly|recvonly|sendrecv|inactive)/,
            `a=${direction}`,
          )
        : section,
    )
    .join("\r\n");
}

export function replaceMediaPortByMid(
  sdp: string | undefined,
  mid: string,
  port: number,
) {
  if (!sdp) {
    throw new Error("sdp is empty");
  }
  return sdp
    .split(/\r\n(?=m=)/)
    .map((section) =>
      section.includes(`a=mid:${mid}\r\n`)
        ? section.replace(/^m=(\S+) \d+/, `m=$1 ${port}`)
        : section,
    )
    .join("\r\n");
}

export function replaceMediaMid(
  sdp: string | undefined,
  from: string,
  to: string,
) {
  if (!sdp) {
    throw new Error("sdp is empty");
  }
  return sdp
    .split(/\r\n(?=m=)/)
    .map((section) =>
      section.includes(`a=mid:${from}\r\n`)
        ? section.replace(`a=mid:${from}`, `a=mid:${to}`)
        : section,
    )
    .join("\r\n");
}

export function rewriteBundleGroup(sdp: string | undefined, mids: string[]) {
  if (!sdp) {
    throw new Error("sdp is empty");
  }
  return sdp.replace(
    /a=group:BUNDLE[^\r\n]*/,
    `a=group:BUNDLE ${mids.join(" ")}`,
  );
}

export async function negotiateOfferAnswer(
  offerer: RTCPeerConnection,
  answerer: RTCPeerConnection,
) {
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
}

export function hostIceCandidateInit(sdpMid: string, sdpMLineIndex: number) {
  return {
    candidate: "candidate:1 1 udp 2113929471 203.0.113.100 10100 typ host",
    sdpMid,
    sdpMLineIndex,
  };
}

export function waitForIceGatheringComplete(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const { unSubscribe } = pc.iceGatheringStateChange.subscribe((state) => {
      if (state === "complete") {
        unSubscribe();
        resolve();
      }
    });
  });
}

export function waitForIceCandidate(
  pc: RTCPeerConnection,
  timeoutMs = 5000,
): Promise<RTCIceCandidate> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unSubscribe();
      reject(new Error("timed out waiting for ICE candidate"));
    }, timeoutMs);
    const { unSubscribe } = pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) {
        return;
      }
      clearTimeout(timeout);
      unSubscribe();
      resolve(candidate);
    });
  });
}
