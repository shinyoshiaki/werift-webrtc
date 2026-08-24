import { EventTarget } from "../helper";
import { MediaStream, type MediaStreamTrack } from "../media/track";
import type {
  BoundMediaRegister,
  MediaStreamConstraints,
  MediaTrackConstraints,
} from "./mediaRegister";
import { normalizeTrackConstraints } from "./mediaRegister";
import {
  type MediaKind,
  type PolyfillTrackConstraints,
  assertRequestedMediaTypes,
  polyfillSupportedConstraints,
  selectRegisterForKind,
} from "./selectSettings";

export class MediaDevices extends EventTarget {
  ondevicechange: ((this: MediaDevices, ev: Event) => unknown) | null = null;
  private readonly activeStops = new Map<MediaStreamTrack, () => void>();

  constructor(private readonly registers: BoundMediaRegister[]) {
    super();
  }

  getSupportedConstraints() {
    return { ...polyfillSupportedConstraints };
  }

  async enumerateDevices(): Promise<MediaDeviceInfoLike[]> {
    const devices: MediaDeviceInfoLike[] = [];
    for (const register of this.registers) {
      for (const kind of register.kinds) {
        devices.push({
          deviceId: register.deviceId,
          groupId: register.groupId ?? "",
          kind: kind === "audio" ? "audioinput" : "videoinput",
          label: register.label ?? "",
          toJSON() {
            return {
              deviceId: this.deviceId,
              groupId: this.groupId,
              kind: this.kind,
              label: this.label,
            };
          },
        });
      }
    }
    return devices;
  }

  getUserMedia = async (
    constraints: MediaStreamConstraints = {},
  ): Promise<MediaStream> => {
    assertRequestedMediaTypes(constraints);
    const tracks: MediaStreamTrack[] = [];
    if (constraints.audio) {
      tracks.push(...(await this.createKindTracks("audio", constraints.audio)));
    }
    if (constraints.video) {
      tracks.push(...(await this.createKindTracks("video", constraints.video)));
    }
    return new MediaStream(tracks);
  };

  getDisplayMedia = this.getUserMedia;

  cleanup() {
    for (const stop of this.activeStops.values()) {
      stop();
    }
    this.activeStops.clear();
    for (const register of this.registers) {
      register.stop?.();
    }
  }

  private async createKindTracks(
    kind: MediaKind,
    constraints: boolean | MediaTrackConstraints,
  ) {
    const selected = selectRegisterForKind(
      kind,
      constraints as boolean | PolyfillTrackConstraints,
      this.registers,
    );
    const register = this.registers.find(
      (candidate) => candidate.deviceId === selected.deviceId,
    );
    if (!register) {
      throw new Error(`Selected ${kind} register was not found`);
    }
    const normalized = normalizeTrackConstraints(constraints);
    const tracks = await register.createTracks({
      kind,
      deviceId: register.deviceId,
      constraints: normalized,
    });
    for (const track of tracks) {
      this.watchTrack(track);
    }
    return tracks;
  }

  private watchTrack(track: MediaStreamTrack) {
    const originalStop = track.stop;
    track.stop = () => {
      this.activeStops.delete(track);
      originalStop.call(track);
    };
    this.activeStops.set(track, () => track.stop());
  }
}

export interface MediaDeviceInfoLike {
  deviceId: string;
  groupId: string;
  kind: "audioinput" | "videoinput" | "audiooutput";
  label: string;
  toJSON(): {
    deviceId: string;
    groupId: string;
    kind: string;
    label: string;
  };
}
