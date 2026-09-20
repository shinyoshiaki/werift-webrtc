import {
  MediaStreamTrack,
  type RTCIceCandidate,
  RTCPeerConnection,
  type RTCPeerConnectionConfig,
  type RTCRtpTransceiver,
  RtpHeader,
  RtpPacket,
  SessionDescription,
  useOPUS,
  useSdesMid,
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

export function stripSsrcLines(sdp: string | undefined) {
  if (!sdp) {
    throw new Error("sdp is empty");
  }
  return sdp
    .split("\r\n")
    .filter((line) => !line.startsWith("a=ssrc"))
    .join("\r\n");
}

export function stripPcmuFromOffer(sdp: string | undefined) {
  if (!sdp) {
    throw new Error("sdp is empty");
  }
  return sdp
    .replace(
      "m=audio 9 UDP/TLS/RTP/SAVPF 96 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 96",
    )
    .replace(/\r\na=rtpmap:0 PCMU\/8000/, "");
}

export function getSectionUfrag(sdp: string | undefined, mid: string) {
  if (!sdp) {
    throw new Error("sdp is empty");
  }
  const section = sdp
    .split(/\r\n(?=m=)/)
    .find((part) => part.includes(`a=mid:${mid}\r\n`));
  return section?.split("\r\n").find((line) => line.startsWith("a=ice-ufrag:"));
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

export async function createReuseScenario(
  config: RTCPeerConnectionConfig = {},
  { dataFirst = false, videoFirst = false } = {},
) {
  const offerer = createBundledPeerConnection(config);
  const answerer = createBundledPeerConnection(config);
  if (dataFirst) {
    offerer.createDataChannel("anchor");
    await negotiateOfferAnswer(offerer, answerer);
  }
  const track = new MediaStreamTrack({ kind: "video" });
  let video: RTCRtpTransceiver;
  if (videoFirst)
    video = offerer.addTransceiver(track, { direction: "sendonly" });
  offerer.addTransceiver("audio", { direction: "sendonly" });
  if (!videoFirst)
    video = offerer.addTransceiver(track, { direction: "sendonly" });
  try {
    // Arrange: 同じ helper で接続と m-line の初期配置を用意する。
    await negotiateOfferAnswer(offerer, answerer);
    return { offerer, answerer, video: video!, track };
  } catch (error) {
    await Promise.all([offerer.close(), answerer.close()]);
    throw error;
  }
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

export function createBundledPeerConnection(
  config: RTCPeerConnectionConfig = {},
) {
  return new RTCPeerConnection({
    iceServers: [],
    bundlePolicy: "max-bundle",
    headerExtensions: { video: [useSdesMid()], audio: [useSdesMid()] },
    ...config,
  });
}

export async function waitForConnection(pc: RTCPeerConnection) {
  if (pc.connectionState === "connected") {
    return;
  }
  await pc.connectionStateChange.watch((state) => state === "connected");
}

export function sendTestRtp(track: MediaStreamTrack, payload: string) {
  track.writeRtp(
    new RtpPacket(new RtpHeader(), Buffer.from(payload)).serialize(),
  );
}

export async function waitForRtp(
  transceiver: RTCRtpTransceiver | undefined,
  timeoutMs = 3000,
) {
  if (!transceiver) {
    throw new Error("transceiver not found");
  }
  return transceiver.receiver.track.onReceiveRtp.asPromise(timeoutMs);
}
