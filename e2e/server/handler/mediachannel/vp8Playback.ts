/**
 * Chrome E2E handlers: werift media sources emit VP8 → Chrome decodes / plays.
 *
 * Sources (Node is offerer, Chrome answers):
 *   file  — webrtc nonstandard userMedia file playback (`createFileMediaPlayer`,
 *           the engine behind the polyfill MP4/WebM register) on fixtures/media/vp8.webm
 *   dummy — `navigator.mediaDevices.getUserMedia` with `dummyMedia` enabled
 *
 * The sent RTP is observed on the source track so the browser test can check
 * the VP8 payload descriptor (X/I/M + PictureID) alongside Chrome's decode stats.
 */
import { join } from "node:path";

import type { AcceptFn } from "protoo-server";
import { Navigator } from "../../../../packages/webrtc/src/nonstandard";
import { createFileMediaPlayer } from "../../../../packages/webrtc/src/nonstandard/userMedia";
import {
  type MediaStreamTrack,
  RTCPeerConnection,
  type RtpPacket,
  useVP8,
  Vp8RtpPayload,
} from "../..";
import { waitForTrackCodec } from "../../codecRtpUtils";
import { DtlsKeysContext } from "../../fixture";

type Vp8PlaybackSource = "file" | "dummy";

const VP8_FIXTURE = join(process.cwd(), "fixtures/media/vp8.webm");

export type Vp8DescriptorStats = {
  packets: number;
  frames: number;
  multiPacketFrames: number;
  /** Packets without the X/I/M extension (minimal descriptor). */
  packetsWithoutPictureId: number;
  /** Fragments whose PictureID differs from the frame's first packet. */
  pictureIdMismatchInFrame: number;
  /** Frame-to-frame PictureID steps other than +1 (15-bit wrap). */
  pictureIdGaps: number;
  /** First few gaps (frame index and PictureID step) for diagnosis. */
  pictureIdGapDetails: { frame: number; from: number; to: number }[];
  firstPictureId?: number;
  lastPictureId?: number;
};

function createDescriptorObserver() {
  const stats: Vp8DescriptorStats = {
    packets: 0,
    frames: 0,
    multiPacketFrames: 0,
    packetsWithoutPictureId: 0,
    pictureIdMismatchInFrame: 0,
    pictureIdGaps: 0,
    pictureIdGapDetails: [],
  };
  let framePictureId: number | undefined;
  let framePackets = 0;

  const onRtp = (rtp: RtpPacket) => {
    const vp8 = Vp8RtpPayload.deSerialize(rtp.payload);
    stats.packets++;
    framePackets++;
    const hasPictureId =
      vp8.xBit === 1 &&
      vp8.iBit === 1 &&
      vp8.mBit === 1 &&
      vp8.pictureId !== undefined;
    if (!hasPictureId) {
      stats.packetsWithoutPictureId++;
    } else if (vp8.sBit === 1 && vp8.pid === 0) {
      // Frame start: PictureID must advance by exactly one per frame.
      if (
        stats.lastPictureId !== undefined &&
        vp8.pictureId !== ((stats.lastPictureId + 1) & 0x7fff)
      ) {
        stats.pictureIdGaps++;
        if (stats.pictureIdGapDetails.length < 5) {
          stats.pictureIdGapDetails.push({
            frame: stats.frames,
            from: stats.lastPictureId,
            to: vp8.pictureId!,
          });
        }
      }
      stats.firstPictureId ??= vp8.pictureId;
      stats.lastPictureId = vp8.pictureId;
      framePictureId = vp8.pictureId;
    } else if (vp8.pictureId !== framePictureId) {
      stats.pictureIdMismatchInFrame++;
    }

    if (rtp.header.marker) {
      stats.frames++;
      if (framePackets > 1) stats.multiPacketFrames++;
      framePackets = 0;
      framePictureId = undefined;
    }
  };

  return { stats, onRtp };
}

class Vp8PlaybackHandler {
  private pc?: RTCPeerConnection;
  private stoppers: (() => void)[] = [];
  private descriptor = createDescriptorObserver();
  private sourceError?: string;

  constructor(private readonly source: Vp8PlaybackSource) {}

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init": {
        await this.cleanup();
        this.descriptor = createDescriptorObserver();
        this.sourceError = undefined;

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          dtls: { keys: await DtlsKeysContext.get() },
          codecs: { video: [useVP8()] },
          bundlePolicy: "max-bundle",
        });
        this.pc = pc;

        const track = await this.createSourceTrack();
        const { unSubscribe } = track.onReceiveRtp.subscribe(
          this.descriptor.onRtp,
        );
        this.stoppers.push(unSubscribe);
        pc.addTransceiver(track, { direction: "sendonly" });

        await pc.setLocalDescription(await pc.createOffer());
        accept(pc.localDescription);
        break;
      }
      case "candidate": {
        if (payload) {
          await this.pc?.addIceCandidate(payload);
        }
        accept({});
        break;
      }
      case "answer": {
        await this.pc?.setRemoteDescription(payload);
        accept({});
        break;
      }
      case "status": {
        accept({
          source: this.source,
          sourceError: this.sourceError,
          ...this.descriptor.stats,
        });
        break;
      }
      case "done": {
        await this.cleanup();
        accept({});
        break;
      }
    }
  }

  private async createSourceTrack(): Promise<MediaStreamTrack> {
    switch (this.source) {
      case "file": {
        const player = await createFileMediaPlayer({
          path: VP8_FIXTURE,
          loop: true,
        });
        this.stoppers.push(() => player.stop());
        player.onError.subscribe((error) => {
          this.sourceError = error.message;
        });
        const track = player.video!;
        // Playback needs the negotiated codec on the track (set by the sender).
        void waitForTrackCodec(track)
          .then(() => player.start())
          .catch((error: Error) => {
            this.sourceError = error.message;
          });
        return track;
      }
      case "dummy": {
        const navigator = new Navigator({ dummyMedia: { enabled: true } });
        this.stoppers.push(() => navigator.mediaDevices.cleanup());
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        return stream.getVideoTracks()[0];
      }
    }
  }

  private async cleanup() {
    for (const stop of this.stoppers) {
      try {
        stop();
      } catch {}
    }
    this.stoppers = [];
    await this.pc?.close();
    this.pc = undefined;
  }
}

export const vp8PlaybackHandlers = {
  mediachannel_vp8_playback_file: new Vp8PlaybackHandler("file"),
  mediachannel_vp8_playback_dummy: new Vp8PlaybackHandler("dummy"),
};
