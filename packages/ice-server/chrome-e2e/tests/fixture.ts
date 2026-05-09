export type HarnessConfig = {
  stun: {
    url: string;
  };
  turn: {
    udpUrl: string;
    tcpUrl: string;
    tlsUrl: string;
    username: string;
    credential: string;
  };
};

export type HarnessMetrics = {
  stunBindingRequests: number;
};

type ConnectedPeerPair = {
  offerer: RTCPeerConnection;
  answerer: RTCPeerConnection;
  offererChannel: RTCDataChannel;
  answererChannel: RTCDataChannel;
  close: () => Promise<void>;
};

const harnessPort = import.meta.env.VITE_CHROME_E2E_PORT ?? "8887";
const harnessBaseUrl = `http://127.0.0.1:${harnessPort}`;

export async function getHarnessConfig(): Promise<HarnessConfig> {
  const response = await fetch(`${harnessBaseUrl}/config`);
  if (!response.ok) {
    throw new Error(`failed to fetch chrome-e2e config: ${response.status}`);
  }
  return response.json() as Promise<HarnessConfig>;
}

export async function resetHarnessMetrics() {
  const response = await fetch(`${harnessBaseUrl}/metrics/reset`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`failed to reset chrome-e2e metrics: ${response.status}`);
  }
}

export async function getHarnessMetrics(): Promise<HarnessMetrics> {
  const response = await fetch(`${harnessBaseUrl}/metrics`);
  if (!response.ok) {
    throw new Error(`failed to fetch chrome-e2e metrics: ${response.status}`);
  }
  return response.json() as Promise<HarnessMetrics>;
}

export async function createConnectedPeerPair(
  configuration: RTCConfiguration,
): Promise<ConnectedPeerPair> {
  const offerer = new RTCPeerConnection(configuration);
  const answerer = new RTCPeerConnection(configuration);
  const offererChannel = offerer.createDataChannel("probe");
  const answererChannelPromise = deferred<RTCDataChannel>();

  answerer.ondatachannel = ({ channel }) => {
    answererChannelPromise.resolve(channel);
  };

  const offer = await offerer.createOffer();
  await offerer.setLocalDescription(offer);
  await waitForIceGatheringComplete(offerer);

  await answerer.setRemoteDescription(offerer.localDescription!);
  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription(answer);
  await waitForIceGatheringComplete(answerer);

  await offerer.setRemoteDescription(answerer.localDescription!);

  const answererChannel = await answererChannelPromise.promise;
  await Promise.all([
    waitForPeerConnection(offerer),
    waitForPeerConnection(answerer),
    waitForDataChannelOpen(offererChannel),
    waitForDataChannelOpen(answererChannel),
  ]);

  return {
    offerer,
    answerer,
    offererChannel,
    answererChannel,
    close: async () => {
      offererChannel.close();
      answererChannel.close();
      offerer.close();
      answerer.close();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
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
    }, 10_000);

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
) {
  const stats = await connection.getStats();
  const pair = findSelectedCandidatePair(stats);
  if (!pair) {
    throw new Error("selected ICE candidate pair was not found");
  }

  const localCandidate =
    pair.localCandidateId !== undefined
      ? stats.get(pair.localCandidateId)
      : undefined;
  const remoteCandidate =
    pair.remoteCandidateId !== undefined
      ? stats.get(pair.remoteCandidateId)
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

function waitForIceGatheringComplete(connection: RTCPeerConnection) {
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
    }, 15_000);

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

function waitForPeerConnection(connection: RTCPeerConnection) {
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

function waitForDataChannelOpen(channel: RTCDataChannel) {
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function findSelectedCandidatePair(report: RTCStatsReport) {
  const transport = [...report.values()].find(
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
      const pair = report.get(selectedCandidatePairId);
      if (pair) {
        return pair;
      }
    }
  }

  return [...report.values()].find(
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
