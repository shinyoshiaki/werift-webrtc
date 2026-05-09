/// <reference types="vite/client" />

import Bowser from "bowser";
import { Peer, WebSocketTransport } from "protoo-client";

const browser = Bowser.getParser(window.navigator.userAgent);
export const browserName = browser.getBrowserName();
const e2ePort = import.meta.env.VITE_E2E_PORT ?? "8886";
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

console.log({ browserName, version: browser.getBrowserVersion() });

const transport = new WebSocketTransport(`ws://localhost:${e2ePort}`);
export const peer = new Peer(transport);

export async function waitVideoPlay(track: MediaStreamTrack) {
  const video = document.createElement("video");
  const media = new MediaStream([track]);
  video.srcObject = media;
  video.autoplay = true;
  video.muted = true;
  video.load();
  video.width = 100;
  video.height = 100;
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const context = canvas.getContext("2d")!;
  canvas.width = video.width;
  canvas.height = video.height;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const snapshot = await digestMessage(
    context.getImageData(0, 0, canvas.width, canvas.height).data,
  );

  for (;;) {
    await new Promise((r) => setTimeout(r, 100));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = await digestMessage(
      context.getImageData(0, 0, canvas.width, canvas.height).data,
    );

    if (snapshot !== data) break;
  }

  video.pause();
  video.srcObject = null;
}

async function digestMessage(data: Uint8ClampedArray) {
  const hashBuffer = await crypto.subtle.digest("SHA-1", data); // hash the message
  const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(""); // convert bytes to hex string
  return hashHex;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type TurnRelayConfig = {
  turn: {
    udpUrl: string;
    tcpUrl: string;
    tlsUrl: string;
    username: string;
    credential: string;
  };
};

export type SelectedRelayCandidatePair = {
  localCandidateType?: string;
  remoteCandidateType?: string;
  localCandidateProtocol?: string;
  remoteCandidateProtocol?: string;
  localRelayProtocol?: string;
  remoteRelayProtocol?: string;
};

export async function ensurePeerConnected() {
  if (!peer.connected) {
    await new Promise<void>((resolve) => peer.on("open", resolve));
  }
}

export async function getTurnRelayConfig(): Promise<TurnRelayConfig> {
  const response = await fetch(`${e2eBaseUrl}/turn-config`);
  if (!response.ok) {
    throw new Error(`failed to fetch turn relay config: ${response.status}`);
  }
  return response.json() as Promise<TurnRelayConfig>;
}

export function waitForIceGatheringComplete(connection: RTCPeerConnection) {
  if (connection.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.removeEventListener(
        "icegatheringstatechange",
        handleIceGatheringStateChange,
      );
      reject(new Error("ICE gathering did not complete in time"));
    }, 20_000);

    const handleIceGatheringStateChange = () => {
      if (connection.iceGatheringState !== "complete") {
        return;
      }
      clearTimeout(timer);
      connection.removeEventListener(
        "icegatheringstatechange",
        handleIceGatheringStateChange,
      );
      resolve();
    };

    connection.addEventListener(
      "icegatheringstatechange",
      handleIceGatheringStateChange,
    );
  });
}

export function waitForPeerConnection(connection: RTCPeerConnection) {
  if (connection.connectionState === "connected") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.removeEventListener(
        "connectionstatechange",
        handleStateChange,
      );
      reject(
        new Error(
          `peer connection did not connect: ${connection.connectionState}`,
        ),
      );
    }, 20_000);

    const handleStateChange = () => {
      if (connection.connectionState !== "connected") {
        return;
      }
      clearTimeout(timer);
      connection.removeEventListener(
        "connectionstatechange",
        handleStateChange,
      );
      resolve();
    };

    connection.addEventListener("connectionstatechange", handleStateChange);
  });
}

export function waitForDataChannelOpen(channel: RTCDataChannel) {
  if (channel.readyState === "open") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.removeEventListener("open", handleOpen);
      reject(new Error("data channel did not open in time"));
    }, 20_000);

    const handleOpen = () => {
      clearTimeout(timer);
      channel.removeEventListener("open", handleOpen);
      resolve();
    };

    channel.addEventListener("open", handleOpen);
  });
}

export async function expectMessage(
  channel: RTCDataChannel,
  expected: string,
  send: () => void,
) {
  const messagePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.removeEventListener("message", handleMessage);
      reject(new Error(`timed out waiting for "${expected}"`));
    }, 20_000);

    const handleMessage = (event: MessageEvent<string>) => {
      clearTimeout(timer);
      channel.removeEventListener("message", handleMessage);
      resolve(event.data);
    };

    channel.addEventListener("message", handleMessage, { once: true });
  });

  send();
  expect(await messagePromise).toBe(expected);
}

export async function getSelectedRelayCandidatePair(
  connection: RTCPeerConnection,
): Promise<SelectedRelayCandidatePair> {
  const stats = await connection.getStats();
  const statsMap = stats as unknown as Map<string, RTCStats>;
  const pair = findSelectedCandidatePair(stats);
  if (!pair) {
    throw new Error("selected ICE candidate pair was not found");
  }
  const selectedPair = pair as RTCStats & {
    localCandidateId?: string;
    remoteCandidateId?: string;
  };

  const localCandidate =
    selectedPair.localCandidateId !== undefined
      ? statsMap.get(selectedPair.localCandidateId)
      : undefined;
  const remoteCandidate =
    selectedPair.remoteCandidateId !== undefined
      ? statsMap.get(selectedPair.remoteCandidateId)
      : undefined;

  return {
    localCandidateType: readStatString(localCandidate, "candidateType"),
    remoteCandidateType: readStatString(remoteCandidate, "candidateType"),
    localCandidateProtocol: readStatString(localCandidate, "protocol"),
    remoteCandidateProtocol: readStatString(remoteCandidate, "protocol"),
    localRelayProtocol: readStatString(localCandidate, "relayProtocol"),
    remoteRelayProtocol: readStatString(remoteCandidate, "relayProtocol"),
  };
}

export class Counter {
  private now = 0;
  constructor(
    private times: number,
    private finished: () => void,
  ) {}

  done() {
    if (++this.now === this.times) {
      this.finished();
    }
  }
}

function findSelectedCandidatePair(report: RTCStatsReport) {
  const reportMap = report as unknown as Map<string, RTCStats>;
  const transport = [...reportMap.values()].find(
    (stat) =>
      stat.type === "transport" &&
      typeof readStatString(stat, "selectedCandidatePairId") === "string",
  );

  if (transport) {
    const selectedCandidatePairId = readStatString(
      transport,
      "selectedCandidatePairId",
    );
    if (selectedCandidatePairId) {
      const pair = reportMap.get(selectedCandidatePairId);
      if (pair) {
        return pair;
      }
    }
  }

  return [...reportMap.values()].find(
    (stat) =>
      stat.type === "candidate-pair" &&
      readStatBoolean(stat, "selected") === true,
  );
}

function readStatBoolean(stat: RTCStats | undefined, key: string) {
  return stat && key in stat
    ? Boolean((stat as unknown as Record<string, unknown>)[key])
    : undefined;
}

function readStatString(stat: RTCStats | undefined, key: string) {
  if (!stat || !(key in stat)) {
    return undefined;
  }
  const value = (stat as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
