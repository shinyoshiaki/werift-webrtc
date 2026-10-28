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
  encodedFrames: 0,
  receivedPackets: 0,
  missingPackets: 0,
  recoveredPackets: 0,
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
let lastSequence: number | undefined;
const sequenceGap = new Set<number>();

function update() {
  metrics.textContent = JSON.stringify(result, null, 2);
  (window as any).__latencyBudgetResult = { ...result };
}

function createPlayer() {
  if (!("AudioDecoder" in window) || !("AudioWorkletNode" in window)) {
    status.textContent = "WebCodecs AudioDecoder / AudioWorklet が必要です";
    return;
  }
  context = new AudioContext();
  void context.audioWorklet.addModule("./player-worklet.js").then(() => {
    worklet = new AudioWorkletNode(context!, "latency-budget-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    worklet.connect(context!.destination);
    decoder = new AudioDecoder({
      output: (audioData) => {
        const samples = new Float32Array(audioData.numberOfFrames);
        audioData.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
        worklet?.port.postMessage({ type: "samples", samples }, [
          samples.buffer,
        ]);
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
  });
}

function attachTransform(receiver: RTCRtpReceiver) {
  const encodedReceiver = receiver as RTCRtpReceiver & {
    createEncodedStreams?: () => {
      readable: ReadableStream<EncodedAudio>;
      writable: WritableStream<EncodedAudio>;
    };
  };
  if (!encodedReceiver.createEncodedStreams) {
    result.transform = "RTCRtpScriptTransform required";
    status.textContent = "この Chromium は createEncodedStreams に未対応です";
    update();
    return;
  }
  result.transform = "createEncodedStreams";
  const streams = encodedReceiver.createEncodedStreams();
  const transform = new TransformStream<EncodedAudio, EncodedAudio>({
    transform(frame, controller) {
      const metadata = frame.getMetadata?.() ?? {};
      const sequence = metadata.sequenceNumber as number | undefined;
      const timestamp = (metadata.rtpTimestamp ?? frame.timestamp) as number;
      result.encodedFrames++;
      result.receivedPackets++;
      result.rtpTimestamp = timestamp;
      if (sequence != null && lastSequence != null) {
        const delta = (sequence - lastSequence + 65536) % 65536;
        if (delta > 1 && delta < 32768) {
          for (let n = 1; n < delta; n++) {
            const lost = (lastSequence + n) % 65536;
            sequenceGap.add(lost);
            result.missingPackets++;
          }
        } else if (sequenceGap.delete(sequence)) {
          result.recoveredPackets++;
        }
      }
      if (sequence != null) lastSequence = sequence;
      if (decoder && frame.data.byteLength) {
        try {
          decoder.decode(
            new EncodedAudioChunk({
              type: "key",
              timestamp: Math.round((timestamp * 1_000_000) / 48000),
              data: frame.data,
            }),
          );
        } catch {
          /* decode errors are reflected by the browser decoder */
        }
      }
      if (sequenceGap.size && channel?.readyState === "open") {
        channel.send(
          JSON.stringify({ type: "nack", sequenceNumbers: [...sequenceGap] }),
        );
      }
      update();
      controller.enqueue(frame);
    },
  });
  void streams.readable
    .pipeThrough(transform)
    .pipeTo(streams.writable)
    .catch((error) => {
      status.textContent = `transform stopped: ${error}`;
    });
}

$("start").addEventListener("click", async () => {
  $("start").setAttribute("disabled", "");
  createPlayer();
  const local = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  pc = new RTCPeerConnection({ iceServers: [] });
  pc.addTrack(local.getAudioTracks()[0]);
  pc.ontrack = (event) => {
    nativeAudio.srcObject = event.streams[0];
    attachTransform(event.receiver);
  };
  pc.onconnectionstatechange = () => {
    result.connected = pc.connectionState === "connected";
    status.textContent = pc.connectionState;
    update();
  };
  channel = pc.createDataChannel("latency-budget");
  channel.onopen = () => {
    $("burst").removeAttribute("disabled");
    $("interrupt").removeAttribute("disabled");
  };
  channel.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "nack")
      result.missingPackets = Math.max(
        0,
        result.missingPackets - message.sequenceNumbers.length,
      );
    update();
  };
  socket = new WebSocket(`ws://${location.hostname}:8888`);
  socket.onmessage = async ({ data }) => {
    const message = JSON.parse(data);
    if (message.type !== "answer") return;
    await pc.setRemoteDescription(message.description);
  };
  await new Promise<void>((resolve) => {
    socket.onopen = () => resolve();
  });
  const offer = await pc.createOffer();
  const munged =
    offer.sdp?.replace(
      /(a=rtpmap:(\d+) opus\/48000[^\r\n]*\r?\n)/i,
      "$1a=rtcp-fb:$2 nack\r\n",
    ) ?? offer.sdp;
  await pc.setLocalDescription({ type: offer.type, sdp: munged });
  socket.send(
    JSON.stringify({
      type: "offer",
      description: pc.localDescription,
      budgetMs: Number($<HTMLSelectElement>("budget").value),
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
