/**
 * Chrome E2E handlers: Chrome sends camera media → werift MediaRecorder saves a
 * WebM file → werift returns the file over a DataChannel → Chrome plays it.
 *
 * Chrome is the offerer (sendonly media + DataChannel "record").
 * DataChannel protocol (Chrome → Node: "stop"):
 *   Node → Chrome: {"type":"header","size":N} (JSON string)
 *   Node → Chrome: binary chunks (N bytes in total)
 *   Node → Chrome: {"type":"eof"} (JSON string)
 *   on failure: {"type":"error","message":...}
 */
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcceptFn } from "protoo-server";
import { MediaRecorder } from "../../../../packages/webrtc/src/nonstandard";
import { type RTCDataChannel, RTCPeerConnection, useOPUS, useVP8 } from "../..";
import { DtlsKeysContext } from "../../fixture";

type RecordKinds = "video" | "av";

const CHUNK_SIZE = 16 * 1024;
const BUFFERED_HIGH = 1024 * 1024;

export type RecordPlaybackStatus = {
  kinds: RecordKinds;
  tracks: number;
  rtpPackets: Record<string, number>;
  fileSize?: number;
  error?: string;
};

class RecordPlaybackHandler {
  private pc?: RTCPeerConnection;
  private recorder?: MediaRecorder;
  private path?: string;
  private intervals: NodeJS.Timeout[] = [];
  private status!: RecordPlaybackStatus;

  constructor(private readonly kinds: RecordKinds) {}

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init": {
        await this.cleanup();
        const numOfTracks = this.kinds === "av" ? 2 : 1;
        this.status = {
          kinds: this.kinds,
          tracks: 0,
          rtpPackets: {},
        };
        this.path = join(tmpdir(), `werift-e2e-record-${randomUUID()}.webm`);
        this.recorder = new MediaRecorder({
          path: this.path,
          numOfTracks,
          width: 640,
          height: 480,
        });
        this.recorder.onError.subscribe((error) => {
          this.status.error ??= String(error);
        });

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          dtls: { keys: await DtlsKeysContext.get() },
          codecs: { video: [useVP8()], audio: [useOPUS()] },
          bundlePolicy: "max-bundle",
        });
        this.pc = pc;

        pc.onRemoteTransceiverAdded.subscribe((transceiver) => {
          transceiver.onTrack.subscribe(async (track) => {
            this.status.tracks++;
            this.status.rtpPackets[track.kind] = 0;
            track.onReceiveRtp.subscribe(() => {
              this.status.rtpPackets[track.kind]++;
            });
            if (track.kind === "video") {
              // 録画先頭とその後もキーフレームが届くよう定期的に PLI を送る
              this.intervals.push(
                setInterval(() => {
                  transceiver.receiver.sendRtcpPLI(track.ssrc);
                }, 2_000),
              );
            }
            await this.recorder!.addTrack(track);
          });
        });
        pc.onDataChannel.subscribe((dc) => {
          dc.onMessage.subscribe((message) => {
            if (message === "stop") {
              this.stopAndSend(dc).catch((error) => {
                this.status.error ??= String(error);
                dc.send(
                  JSON.stringify({ type: "error", message: String(error) }),
                );
              });
            }
          });
        });

        await pc.setRemoteDescription(payload);
        await pc.setLocalDescription(await pc.createAnswer());
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
      case "status": {
        accept(this.status);
        break;
      }
      case "done": {
        await this.cleanup();
        accept({});
        break;
      }
    }
  }

  private async stopAndSend(dc: RTCDataChannel) {
    for (const interval of this.intervals) clearInterval(interval);
    this.intervals = [];
    await this.recorder!.stop();

    const file = await readFile(this.path!);
    this.status.fileSize = file.length;
    dc.bufferedAmountLowThreshold = BUFFERED_HIGH / 4;
    dc.send(JSON.stringify({ type: "header", size: file.length }));
    for (let offset = 0; offset < file.length; offset += CHUNK_SIZE) {
      if (dc.bufferedAmount > BUFFERED_HIGH) {
        await dc.bufferedAmountLow.asPromise(10_000);
      }
      dc.send(file.subarray(offset, offset + CHUNK_SIZE));
    }
    dc.send(JSON.stringify({ type: "eof" }));
  }

  private async cleanup() {
    for (const interval of this.intervals) clearInterval(interval);
    this.intervals = [];
    await this.pc?.close().catch(() => {});
    this.pc = undefined;
    this.recorder = undefined;
    if (this.path) {
      await unlink(this.path).catch(() => {});
      this.path = undefined;
    }
  }
}

export const recordPlaybackHandlers = {
  mediachannel_record_playback_video: new RecordPlaybackHandler("video"),
  mediachannel_record_playback_av: new RecordPlaybackHandler("av"),
};
