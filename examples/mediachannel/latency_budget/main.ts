type EncodedAudio = RTCEncodedAudioFrame & {
  getMetadata?: () => Record<string, any>;
};

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const status = $("status");
const metrics = $("metrics");
const nativeAudio = $("native-audio") as HTMLAudioElement;
const result = {
  connected: false,
  outboundPackets: 0,
  encodedFrames: 0,
  receivedPackets: 0,
  missingPackets: 0,
  recoveredPackets: 0,
  weriftMissing: 0,
  weriftRecovered: 0,
  weriftUnrecovered: 0,
  decodedSamples: 0,
  generation: 0,
  rtpTimestamp: undefined as number | undefined,
  transform: "unavailable",
};
(window as any).__latencyBudgetResult = result;

let pc: RTCPeerConnection;
let socket: WebSocket;
let channel: RTCDataChannel;
let decoder: AudioDecoder | undefined;
let worklet: AudioWorkletNode | undefined;
let context: AudioContext | undefined;
let transformWorker: Worker | undefined;
let lastSequence: number | undefined;
const sequenceGap = new Set<number>();
const pendingAppNacks = new Map<number, number>();

function update() {
  metrics.textContent = JSON.stringify(result, null, 2);
  (window as any).__latencyBudgetResult = { ...result };
}

async function createPlayer() {
  if (!("AudioDecoder" in window) || !("AudioWorkletNode" in window)) {
    status.textContent = "WebCodecs AudioDecoder / AudioWorklet が必要です";
    return;
  }
  context = new AudioContext();
  await context.resume();
  await context.audioWorklet.addModule("./player-worklet.js");
  worklet = new AudioWorkletNode(context, "latency-budget-player", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  worklet.connect(context.destination);
  decoder = new AudioDecoder({
    output: (audioData) => {
      const samples = new Float32Array(audioData.numberOfFrames);
      audioData.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
      worklet?.port.postMessage({ type: "samples", samples }, [samples.buffer]);
      result.decodedSamples += audioData.numberOfFrames;
      audioData.close();
      update();
    },
    error: (error) => {
      status.textContent = `decoder error: ${error.message}`;
    },
  });
  decoder.configure({
    codec: "opus",
    sampleRate: 48000,
    numberOfChannels: 2,
  });
  nativeAudio.muted = true;
  status.textContent = "Encoded Transform player ready";
}

function acceptFrame(
  metadata: Record<string, any>,
  timestamp: number,
  data?: ArrayBuffer,
) {
  const sequence = metadata.sequenceNumber as number | undefined;
  result.encodedFrames++;
  result.receivedPackets++;
  result.rtpTimestamp = timestamp;
  if (sequence != null && lastSequence != null) {
    const delta = (sequence - lastSequence + 65536) % 65536;
    if (delta > 1 && delta < 32768) {
      for (let n = 1; n < delta; n++) {
        const lost = (lastSequence + n) % 65536;
        sequenceGap.add(lost);
        pendingAppNacks.set(lost, performance.now());
        result.missingPackets++;
      }
    } else if (sequenceGap.delete(sequence)) {
      pendingAppNacks.delete(sequence);
      result.recoveredPackets++;
    }
  }
  if (sequence != null) lastSequence = sequence;
  if (decoder && data?.byteLength) {
    try {
      decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: Math.round((timestamp * 1_000_000) / 48000),
          data,
        }),
      );
    } catch {
      /* decode errors are reflected by the browser decoder */
    }
  }
  const budgetMs = Number($<HTMLSelectElement>("budget").value);
  const now = performance.now();
  for (const [lost, detectedAt] of pendingAppNacks) {
    if (now - detectedAt > budgetMs) pendingAppNacks.delete(lost);
  }
  const retryable = [...pendingAppNacks]
    .filter(([, detectedAt]) => now - detectedAt <= budgetMs)
    .map(([lost]) => lost);
  if (retryable.length && channel?.readyState === "open") {
    channel.send(JSON.stringify({ type: "nack", sequenceNumbers: retryable }));
  }
  update();
}

function attachTransform(receiver: RTCRtpReceiver) {
  const encodedReceiver = receiver as RTCRtpReceiver & {
    createEncodedStreams?: () => {
      readable: ReadableStream<EncodedAudio>;
      writable: WritableStream<EncodedAudio>;
    };
  };
  if (encodedReceiver.createEncodedStreams) {
    result.transform = "createEncodedStreams";
    const streams = encodedReceiver.createEncodedStreams();
    const transform = new TransformStream<EncodedAudio, EncodedAudio>({
      transform(frame, controller) {
        const metadata = frame.getMetadata?.() ?? {};
        const timestamp = (metadata.rtpTimestamp ?? frame.timestamp) as number;
        acceptFrame(
          metadata,
          timestamp,
          frame.data.slice().buffer as ArrayBuffer,
        );
        controller.enqueue(frame);
      },
    });
    void streams.readable
      .pipeThrough(transform)
      .pipeTo(streams.writable)
      .catch((error) => {
        status.textContent = `transform stopped: ${error}`;
      });
  } else if ("RTCRtpScriptTransform" in window) {
    result.transform = "RTCRtpScriptTransform";
    transformWorker = new Worker("./transform-worker.js");
    transformWorker.onmessage = ({ data }) => {
      if (data.type === "frame")
        acceptFrame(data.metadata, data.timestamp, data.payload);
    };
    (receiver as any).transform = new (window as any).RTCRtpScriptTransform(
      transformWorker,
      { operation: "inspect" },
    );
  } else {
    result.transform = "unavailable";
    status.textContent = "Encoded Transform API がこの Chrome で使えません";
  }
  update();
}

$("start").addEventListener("click", async () => {
  $("start").setAttribute("disabled", "");
  await createPlayer();
  const role = $<HTMLSelectElement>("role").value;
  pc = new RTCPeerConnection({
    iceServers: [],
    encodedInsertableStreams: true,
  } as RTCConfiguration & { encodedInsertableStreams: boolean });
  if (role === "publisher") {
    if ($<HTMLSelectElement>("source").value === "microphone") {
      const input = await navigator.mediaDevices.getUserMedia({ audio: true });
      pc.addTrack(input.getAudioTracks()[0]);
    } else {
      const source = context!.createOscillator();
      const audioStream = context!.createMediaStreamDestination();
      source.frequency.value = 440;
      source.connect(audioStream);
      source.connect(context!.destination);
      source.start();
      pc.addTrack(audioStream.stream.getAudioTracks()[0]);
    }
  } else {
    pc.addTransceiver("audio", { direction: "recvonly" });
  }
  pc.ontrack = (event) => {
    nativeAudio.srcObject = event.streams[0];
    attachTransform(event.receiver);
  };
  pc.onconnectionstatechange = () => {
    result.connected = pc.connectionState === "connected";
    status.textContent = pc.connectionState;
    update();
    if (pc.connectionState === "connected") {
      setTimeout(async () => {
        const report = await pc.getStats();
        const outbound = Array.from(report.values()).find(
          (stat) => stat.type === "outbound-rtp" && stat.kind === "audio",
        );
        result.outboundPackets = outbound?.packetsSent ?? 0;
        update();
      }, 1000);
    }
  };
  pc.ondatachannel = ({ channel: dataChannel }) => {
    channel = dataChannel;
    channel.onopen = () => {
      $("burst").removeAttribute("disabled");
      $("interrupt").removeAttribute("disabled");
    };
  };
  socket = new WebSocket(`ws://${location.hostname}:8888`);
  socket.onmessage = async ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "metrics") {
      result.weriftMissing = message.weriftMissing;
      result.weriftRecovered = message.weriftRecovered;
      result.weriftUnrecovered = message.weriftUnrecovered;
      update();
      return;
    }
    if (message.type !== "offer") return;
    await pc.setRemoteDescription(message.description);
    await pc.setLocalDescription(await pc.createAnswer());
    if (pc.iceGatheringState !== "complete") {
      await new Promise<void>((resolve) => {
        const onGatheringStateChange = () => {
          if (pc.iceGatheringState === "complete") {
            pc.removeEventListener(
              "icegatheringstatechange",
              onGatheringStateChange,
            );
            resolve();
          }
        };
        pc.addEventListener("icegatheringstatechange", onGatheringStateChange);
      });
    }
    socket.send(
      JSON.stringify({ type: "answer", description: pc.localDescription }),
    );
  };
  await new Promise<void>((resolve) => {
    socket.onopen = () => resolve();
  });
  socket.send(
    JSON.stringify({
      type: "init",
      budgetMs: Number($<HTMLSelectElement>("budget").value),
      role,
    }),
  );
});

$("burst").addEventListener("click", () =>
  channel.send(
    JSON.stringify({ type: "burst", generation: result.generation }),
  ),
);
$("interrupt").addEventListener("click", () => {
  result.generation++;
  decoder?.reset();
  worklet?.port.postMessage({ type: "clear" });
  channel.send(
    JSON.stringify({ type: "interrupt", generation: result.generation }),
  );
  update();
});
$("native").addEventListener("click", () => {
  nativeAudio.muted = !nativeAudio.muted;
});
