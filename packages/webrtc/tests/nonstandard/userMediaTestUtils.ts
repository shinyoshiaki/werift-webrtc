import { tmpdir } from "os";
import { join } from "path";
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "fs/promises";

import {
  BufferSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MP4,
  Output,
  WEBM,
  WebMOutputFormat,
} from "mediabunny";

import {
  RTCPeerConnection,
  type RTCRtpCodecParameters,
  useOPUS,
} from "../../src";
import type { RtpPacket } from "../../src/imports/rtp";
import type { MediaStreamTrack } from "../../src/media/track";
import {
  DepacketizeCallback,
  JitterBufferCallback,
  MP4Callback,
  RtpSourceCallback,
  RtpTimeCallback,
  WebmCallback,
} from "../../src/nonstandard";
import { createFileMediaPlayer } from "../../src/nonstandard/userMedia";
import { createMp4WebmRegister, installPolyfill } from "../../src/polyfill";
import "../../src/polyfill";

export async function createAvMp4Buffer() {
  const outputs: Uint8Array[] = [];
  const done = createDeferred<void>();
  const mp4 = new MP4Callback([
    {
      kind: "audio",
      codec: "opus",
      clockRate: 48_000,
      trackNumber: 1,
    },
    {
      kind: "video",
      codec: "avc1",
      clockRate: 90_000,
      width: 640,
      height: 360,
      trackNumber: 2,
    },
  ]);

  mp4.pipe(async (output) => {
    if ("data" in output) {
      outputs.push(output.data);
    } else if ("eol" in output && output.eol) {
      done.resolve();
    }
  });

  const audioFrames = createOpusFrames();
  const videoFrames = createH264Frames();
  mp4.inputAudio({ frame: audioFrames[0] });
  mp4.inputVideo({ frame: videoFrames[0] });
  mp4.inputAudio({ frame: audioFrames[1] });
  mp4.inputVideo({ frame: videoFrames[1] });
  mp4.inputAudio({ frame: audioFrames[2] });
  mp4.inputVideo({ frame: videoFrames[2] });
  mp4.inputAudio({ eol: true });
  mp4.inputVideo({ eol: true });

  await done.promise;

  return Buffer.concat(outputs.map((output) => Buffer.from(output)));
}

export async function createOpusMp4Buffer() {
  const outputs: Uint8Array[] = [];
  const done = createDeferred<void>();
  const mp4 = new MP4Callback([
    {
      kind: "audio",
      codec: "opus",
      clockRate: 48_000,
      trackNumber: 1,
    },
  ]);

  mp4.pipe(async (output) => {
    if ("data" in output) {
      outputs.push(output.data);
    } else if ("eol" in output && output.eol) {
      done.resolve();
    }
  });

  const audioFrames = createOpusFrames();
  mp4.inputAudio({ frame: audioFrames[0] });
  mp4.inputAudio({ frame: audioFrames[1] });
  mp4.inputAudio({ frame: audioFrames[2] });
  mp4.inputAudio({ eol: true });

  await done.promise;

  return Buffer.concat(outputs.map((output) => Buffer.from(output)));
}

export async function createAvWebmBuffer() {
  return createWebmBuffer({
    videoCodec: "vp8",
    videoFrames: createVp8Frames(),
    videoDecoderConfig: {
      codec: "vp8",
      codedWidth: 640,
      codedHeight: 360,
    },
  });
}

export async function createVp9OpusWebmBuffer() {
  return createWebmBuffer({
    videoCodec: "vp9",
    videoFrames: createVp9Frames(),
    videoDecoderConfig: {
      codec: "vp09.00.10.08",
      codedWidth: 640,
      codedHeight: 360,
    },
  });
}

export async function createAv1OpusWebmBuffer() {
  return createWebmBuffer({
    videoCodec: "av1",
    videoFrames: createAv1Frames(),
    videoDecoderConfig: {
      codec: "av01.0.01M.08",
      codedWidth: 640,
      codedHeight: 360,
    },
  });
}

async function createWebmBuffer({
  videoCodec,
  videoFrames,
  videoDecoderConfig,
}: {
  videoCodec: "vp8" | "vp9" | "av1";
  videoFrames: ReturnType<typeof createFrame>[];
  videoDecoderConfig: {
    codec: string;
    codedWidth: number;
    codedHeight: number;
  };
}) {
  const audioSource = new EncodedAudioPacketSource("opus");
  const videoSource = new EncodedVideoPacketSource(videoCodec);
  const output = new Output({
    format: new WebMOutputFormat(),
    target: new BufferTarget(),
  });

  output.addAudioTrack(audioSource);
  output.addVideoTrack(videoSource);
  await output.start();

  const audioFrames = createOpusFrames();
  for (const frame of audioFrames) {
    await audioSource.add(
      new EncodedPacket(frame.data, "key", frame.time / 1_000, 0.02),
      {
        decoderConfig: {
          codec: "opus",
          numberOfChannels: 2,
          sampleRate: 48_000,
        },
      },
    );
  }
  for (const frame of videoFrames) {
    await videoSource.add(
      new EncodedPacket(
        frame.data,
        frame.isKeyframe ? "key" : "delta",
        frame.time / 1_000,
        0.033,
      ),
      {
        decoderConfig: videoDecoderConfig,
      },
    );
  }

  await output.finalize();
  return Buffer.from(output.target.buffer!);
}

export async function createOpusWebmBuffer() {
  const audioSource = new EncodedAudioPacketSource("opus");
  const output = new Output({
    format: new WebMOutputFormat(),
    target: new BufferTarget(),
  });

  output.addAudioTrack(audioSource);
  await output.start();

  const audioFrames = createOpusFrames();
  for (const frame of audioFrames) {
    await audioSource.add(
      new EncodedPacket(frame.data, "key", frame.time / 1_000, 0.02),
      {
        decoderConfig: {
          codec: "opus",
          numberOfChannels: 2,
          sampleRate: 48_000,
        },
      },
    );
  }

  await output.finalize();
  return Buffer.from(output.target.buffer!);
}

export async function createTempMediaFile(buffer: Buffer, extension: string) {
  const directory = await mkdtemp(join(tmpdir(), "werift-user-media-"));
  const path = join(directory, `fixture.${extension}`);
  await writeFile(path, buffer);

  return {
    path,
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function collectFrames(track: MediaStreamTrack, count: number) {
  return new Promise<RtpPacket[][]>((resolve) => {
    const frames: RtpPacket[][] = [];
    let currentFrame: RtpPacket[] = [];

    const { unSubscribe } = track.onReceiveRtp.subscribe((rtp) => {
      currentFrame.push(rtp.clone());
      if (!rtp.header.marker) {
        return;
      }

      frames.push(currentFrame);
      currentFrame = [];
      if (frames.length >= count) {
        unSubscribe();
        resolve(frames);
      }
    });
  });
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const startedAt = performance.now();

  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error("Condition timed out");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

export function createH264Frames() {
  return [
    createFrame(
      Buffer.from(
        "000000016742e01fda01e0089f970110000003000100000300320f1831960000000168ce06e20000000165888421a0",
        "hex",
      ),
      true,
      0,
    ),
    createFrame(Buffer.from("00000001419a2211", "hex"), false, 33),
    createFrame(Buffer.from("00000001419a3344", "hex"), false, 66),
  ];
}

export function createOpusFrames() {
  return [
    createFrame(Buffer.from([0xf8, 0xff, 0xfe, 0x01]), true, 0),
    createFrame(Buffer.from([0xf8, 0xff, 0xfe, 0x02]), true, 20),
    createFrame(Buffer.from([0xf8, 0xff, 0xfe, 0x03]), true, 40),
  ];
}

export function createVp8Frames() {
  return [
    createFrame(
      Buffer.from([
        0x10, 0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x02, 0x00, 0x02, 0x00,
      ]),
      true,
      0,
    ),
    createFrame(Buffer.from([0x10, 0x11, 0x00, 0x00]), false, 33),
    createFrame(Buffer.from([0x10, 0x12, 0x00, 0x00]), false, 66),
  ];
}

export function createVp9Frames() {
  return [
    createFrame(Buffer.alloc(1_500, 0x7b), true, 0),
    createFrame(Buffer.alloc(24, 0x2a), false, 33),
    createFrame(Buffer.alloc(24, 0x3b), false, 66),
  ];
}

export function createAv1Frames() {
  return [
    createFrame(
      Buffer.concat([Buffer.from([0x30]), Buffer.alloc(1_500, 0x55)]),
      true,
      0,
    ),
    createFrame(Buffer.from([0x32, 0xaa, 0xbb, 0xcc]), false, 33),
    createFrame(Buffer.from([0x32, 0xdd, 0xee, 0xff]), false, 66),
  ];
}

function createFrame(data: Buffer, isKeyframe: boolean, time: number) {
  return { data, isKeyframe, time };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

export function getUserMediaE2EAssetPath(
  name: "h264-opus.mp4" | "vp8-opus.webm",
) {
  return join(process.cwd(), "tests/data/nonstandard/userMedia-e2e", name);
}

export async function extractVideoKeyframes(path: string) {
  const input = new Input({
    source: new BufferSource(await readFile(path)),
    formats: [MP4, WEBM],
  });

  try {
    if (!(await input.canRead())) {
      throw new Error(`Unable to parse media asset at ${path}`);
    }

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error(`No video track found in ${path}`);
    }

    const packetSink = new EncodedPacketSink(videoTrack);
    const keyframes: Buffer[] = [];

    for await (const packet of packetSink.packets(undefined, undefined, {
      verifyKeyPackets: true,
    })) {
      if (packet.type === "key") {
        keyframes.push(Buffer.from(packet.data));
      }
    }

    if (keyframes.length === 0) {
      throw new Error(`No keyframes found in ${path}`);
    }

    return keyframes;
  } finally {
    input.dispose();
  }
}

export async function roundTripMediaAsset({
  sourcePath,
  videoCodec,
  recordingFormat,
}: {
  sourcePath: string;
  videoCodec: RTCRtpCodecParameters;
  recordingFormat: "mp4" | "webm";
}) {
  const sender = new RTCPeerConnection({
    codecs: {
      audio: [useOPUS()],
      video: [videoCodec],
    },
  });
  const receiver = new RTCPeerConnection({
    codecs: {
      audio: [useOPUS()],
      video: [videoCodec],
    },
  });
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "werift-user-media-e2e-"),
  );
  const outputPath = join(outputDirectory, `recorded.${recordingFormat}`);
  let keepOutput = false;

  const uninstall = installPolyfill({
    mediaRegister: [
      await createMp4WebmRegister({ path: sourcePath, loop: true }),
    ],
  });
  try {
    exchangeIceCandidates(sender, receiver);
    const remoteTracksPromise = waitForRemoteTracks(receiver);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    const audio = stream.getAudioTracks()[0];
    const video = stream.getVideoTracks()[0];

    if (!audio || !video) {
      uninstall();
      throw new Error(`Expected audio and video tracks in ${sourcePath}`);
    }

    sender.addTrack(audio);
    sender.addTrack(video);

    await exchangeOfferAnswer(sender, receiver);
    await Promise.all([
      waitForPeerConnected(sender),
      waitForPeerConnected(receiver),
    ]);

    const remoteTracks = await remoteTracksPromise;
    const recording = await createTrackRecorder({
      ...remoteTracks,
      path: outputPath,
      recordingFormat,
    });

    try {
      // 実行: polyfill getUserMedia で再生を開始した asset を対向 peer で録画する。
      await waitUntil(() => recording.videoPackets.length > 0, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      audio.stop();
      video.stop();
      await recording.stop();
    }

    keepOutput = true;
    return {
      outputPath,
      recordedVideoPacketCount: recording.videoPackets.length,
      recordedAudioPacketCount: recording.audioPackets.length,
      cleanup: async () => {
        await rm(outputDirectory, { recursive: true, force: true });
      },
    };
  } finally {
    uninstall();
    await Promise.allSettled([sender.close(), receiver.close()]);
    if (!keepOutput) {
      await rm(outputDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

function exchangeIceCandidates(pc1: RTCPeerConnection, pc2: RTCPeerConnection) {
  const pipe = (localPc: RTCPeerConnection, remotePc: RTCPeerConnection) => {
    localPc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) {
        return;
      }
      remotePc.addIceCandidate(candidate).catch((error) => {
        if ((error as Error).message !== "The remote description was null") {
          throw error;
        }
      });
    });
  };

  pipe(pc1, pc2);
  pipe(pc2, pc1);
}

async function exchangeOfferAnswer(
  caller: RTCPeerConnection,
  callee: RTCPeerConnection,
) {
  await caller.setLocalDescription(await caller.createOffer());
  await callee.setRemoteDescription(caller.localDescription!);
  const answer = await callee.createAnswer();
  await caller.setRemoteDescription(answer);
  await callee.setLocalDescription(answer);
}

async function waitForPeerConnected(pc: RTCPeerConnection) {
  if (pc.connectionState === "connected") {
    return;
  }
  await pc.connectionStateChange.watch(
    (state) => state === "connected",
    10_000,
  );
}

function waitForRemoteTracks(pc: RTCPeerConnection) {
  return new Promise<{ audio: MediaStreamTrack; video: MediaStreamTrack }>(
    (resolve) => {
      const tracks: Partial<Record<"audio" | "video", MediaStreamTrack>> = {};

      const resolveIfReady = () => {
        if (tracks.audio && tracks.video) {
          resolve({
            audio: tracks.audio,
            video: tracks.video,
          });
        }
      };

      pc.onRemoteTransceiverAdded.subscribe((transceiver) => {
        transceiver.onTrack.subscribe((track) => {
          tracks[track.kind] = track;
          resolveIfReady();
        });
      });
    },
  );
}

async function createTrackRecorder({
  audio,
  video,
  path,
  recordingFormat,
}: {
  audio: MediaStreamTrack;
  video: MediaStreamTrack;
  path: string;
  recordingFormat: "mp4" | "webm";
}) {
  await unlink(path).catch(() => undefined);

  const audioSource = new RtpSourceCallback();
  const videoSource = new RtpSourceCallback();
  const audioPackets: RtpPacket[] = [];
  const videoPackets: RtpPacket[] = [];
  const finished = createDeferred<void>();

  const audioSubscription = audio.onReceiveRtp.subscribe((rtp) => {
    const cloned = rtp.clone();
    audioPackets.push(cloned);
    audioSource.input(cloned);
  });
  const videoSubscription = video.onReceiveRtp.subscribe((rtp) => {
    const cloned = rtp.clone();
    videoPackets.push(cloned);
    videoSource.input(cloned);
  });

  if (recordingFormat === "mp4") {
    const mp4 = new MP4Callback([
      {
        kind: "audio",
        codec: "opus",
        clockRate: 48_000,
        trackNumber: 1,
      },
      {
        kind: "video",
        codec: "avc1",
        clockRate: 90_000,
        width: 160,
        height: 120,
        trackNumber: 2,
      },
    ]);

    mp4.pipe(async (output) => {
      if ("data" in output) {
        await appendFile(path, output.data);
        return;
      }
      if ("eol" in output && output.eol) {
        finished.resolve();
      }
    });

    const audioTime = new RtpTimeCallback(48_000);
    const audioDepacketizer = new DepacketizeCallback("opus");
    audioSource.pipe(audioTime.input);
    audioTime.pipe(audioDepacketizer.input);
    audioDepacketizer.pipe(mp4.inputAudio);

    const videoJitterBuffer = new JitterBufferCallback(90_000);
    const videoTime = new RtpTimeCallback(90_000);
    const videoDepacketizer = new DepacketizeCallback("MPEG4/ISO/AVC", {
      isFinalPacketInSequence: (header) => header.marker,
    });
    videoSource.pipe(videoJitterBuffer.input);
    videoJitterBuffer.pipe(videoTime.input);
    videoTime.pipe(videoDepacketizer.input);
    videoDepacketizer.pipe(mp4.inputVideo);
  } else {
    const webm = new WebmCallback(
      [
        {
          kind: "audio",
          codec: "OPUS",
          clockRate: 48_000,
          trackNumber: 1,
        },
        {
          kind: "video",
          codec: "VP8",
          clockRate: 90_000,
          width: 160,
          height: 120,
          trackNumber: 2,
        },
      ],
      { duration: 10_000 },
    );

    webm.pipe(async (output) => {
      if (output.saveToFile) {
        await appendFile(path, output.saveToFile);
      }
      if (output.eol) {
        finished.resolve();
      }
    });

    const audioTime = new RtpTimeCallback(48_000);
    const audioDepacketizer = new DepacketizeCallback("opus");
    audioSource.pipe(audioTime.input);
    audioTime.pipe(audioDepacketizer.input);
    audioDepacketizer.pipe(webm.inputAudio);

    const videoJitterBuffer = new JitterBufferCallback(90_000);
    const videoTime = new RtpTimeCallback(90_000);
    const videoDepacketizer = new DepacketizeCallback("VP8", {
      isFinalPacketInSequence: (header) => header.marker,
    });
    videoSource.pipe(videoJitterBuffer.input);
    videoJitterBuffer.pipe(videoTime.input);
    videoTime.pipe(videoDepacketizer.input);
    videoDepacketizer.pipe(webm.inputVideo);
  }

  return {
    audioPackets,
    videoPackets,
    stop: async () => {
      audioSource.stop();
      videoSource.stop();
      await finished.promise;
      audioSubscription.unSubscribe();
      videoSubscription.unSubscribe();
    },
  };
}
