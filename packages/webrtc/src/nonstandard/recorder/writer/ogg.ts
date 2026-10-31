import { unlink } from "fs/promises";
import { type MediaStreamTrack, WeriftError } from "../../..";
import { Event, EventDisposer } from "../../../imports/common";
import {
  DepacketizeCallback,
  JitterBufferCallback,
  NtpTimeCallback,
  OggCallback,
  type OggOutput,
  RtcpSourceCallback,
  RtpSourceCallback,
  RtpTimeCallback,
  saveOggToFileSystem,
} from "../../../imports/rtpExtra";
import { MediaWriter } from ".";

const sourcePath = "packages/webrtc/src/nonstandard/recorder/writer/ogg.ts";

/**
 * Records one Opus audio track into an Ogg Opus file (RFC 7845).
 *
 * The pipeline is the audio branch of WebmFactory without LipsyncCallback:
 * a single audio track has nothing to synchronize with, so `disableLipSync`
 * and `lipsync` are ignored. `width`, `height`, `roll` and `defaultDuration`
 * are ignored as well.
 */
export class OggFactory extends MediaWriter<OggOutput> {
  rtpSources: RtpSourceCallback[] = [];
  private onEol = new Event();
  /**
   * true while an eol is still to come: set once the pipeline is running and
   * cleared when it ends. stop() waits for the eol only in this state, so a
   * recording that never started or failed to start stops immediately
   */
  private running = false;
  /** a write failure stops the recording and is reported here */
  onError = new Event<[Error]>();
  unSubscribers = new EventDisposer();

  /** throws WeriftError unless tracks is exactly one Opus audio track */
  static validateTracks(tracks: MediaStreamTrack[]) {
    OggFactory.validateNumOfTracks(tracks.length);
    for (const track of tracks) {
      OggFactory.validateTrack(track);
    }
  }

  static validateNumOfTracks(numOfTracks: number) {
    if (numOfTracks !== 1) {
      throw new WeriftError({
        message: `ogg recording supports exactly one audio track, got ${numOfTracks}`,
        payload: { numOfTracks },
        path: sourcePath,
      });
    }
  }

  static validateTrack(track: MediaStreamTrack) {
    if (track.kind !== "audio") {
      throw new WeriftError({
        message: `ogg recording does not support ${track.kind} tracks`,
        payload: { kind: track.kind },
        path: sourcePath,
      });
    }
    const codec = track.codec?.name.toLowerCase();
    if (codec !== undefined && codec !== "opus") {
      throw new WeriftError({
        message: `ogg recording supports only opus, got ${track.codec?.name}`,
        payload: { codec: track.codec?.name },
        path: sourcePath,
      });
    }
  }

  async start(tracks: MediaStreamTrack[]) {
    try {
      await this.startPipeline(tracks);
    } catch (error) {
      this.running = false;
      this.unSubscribers.dispose();
      for (const source of this.rtpSources) {
        source.stop();
      }
      throw error;
    }
  }

  private async startPipeline(tracks: MediaStreamTrack[]) {
    OggFactory.validateTracks(tracks);
    const [track] = tracks;
    if (track.codec?.name.toLowerCase() !== "opus") {
      throw new WeriftError({
        message: "ogg recording requires a negotiated opus codec",
        payload: { codec: track.codec?.name },
        path: sourcePath,
      });
    }

    if (this.props.path) {
      await unlink(this.props.path).catch((e) => e);
    }

    // set before the pipeline can emit, so an early write failure clears it
    this.running = true;
    const channels = track.codec.channels === 1 ? 1 : 2;
    const ogg = new OggCallback({ channels });
    ogg.onError.once((error) => {
      this.running = false;
      ogg.destroy();
      // the recording is dead: stop feeding it RTP / RTCP
      this.unSubscribers.dispose();
      for (const source of this.rtpSources) {
        source.stop();
      }
      this.onEol.execute();
      this.onError.execute(error);
    });
    const clockRate = 48000;

    const rtpSource = new RtpSourceCallback();
    const rtcpSource = new RtcpSourceCallback();
    track.onReceiveRtp
      .subscribe((rtp) => {
        rtpSource.input(rtp.clone());
      })
      .disposer(this.unSubscribers);
    track.onReceiveRtcp
      .subscribe((rtcp) => {
        rtcpSource.input(rtcp);
      })
      .disposer(this.unSubscribers);
    const time = this.props.disableNtp
      ? new RtpTimeCallback(clockRate)
      : new NtpTimeCallback(clockRate);
    const depacketizer = new DepacketizeCallback("OPUS");

    // reorders packets so late audio is not written after its gap was filled
    const jitterBuffer = new JitterBufferCallback(
      clockRate,
      this.props.jitterBuffer ?? {},
    );
    rtpSource.pipe(jitterBuffer.input);
    jitterBuffer.pipe(time.input);
    rtcpSource.pipe(time.input);
    time.pipe(depacketizer.input);
    depacketizer.pipe(ogg.inputAudio);
    this.rtpSources = [rtpSource];

    if (this.props.path) {
      const save = saveOggToFileSystem(this.props.path);
      ogg.pipe(async (o) => {
        const eol = await save(o);
        if (this.props.stream) {
          this.props.stream.execute(o);
        }
        if (eol) {
          this.running = false;
          this.onEol.execute();
        }
      });
    } else if (this.props.stream) {
      ogg.pipe(async (o) => {
        this.props.stream.execute(o);
        if (o.eol) {
          this.running = false;
          this.onEol.execute();
        }
      });
    }
  }

  async stop() {
    await Promise.all(this.rtpSources.map((r) => r.stop()));

    if (this.running) {
      await this.onEol.asPromise(5000).catch((e) => e);
    }
    this.unSubscribers.dispose();
  }
}
