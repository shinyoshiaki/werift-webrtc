import { OverconstrainedError, createWebRtcDomException } from "../errors";
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
  private readonly failedRegisters = new Set<BoundMediaRegister>();

  constructor(private readonly registers: BoundMediaRegister[]) {
    super();
  }

  getSupportedConstraints() {
    return { ...polyfillSupportedConstraints };
  }

  async enumerateDevices(): Promise<MediaDeviceInfoLike[]> {
    await this.prepareRegisters();
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
    await this.prepareRegisters();
    const tracks: MediaStreamTrack[] = [];
    try {
      if (constraints.audio) {
        tracks.push(
          ...(await this.createKindTracks("audio", constraints.audio)),
        );
      }
      if (constraints.video) {
        tracks.push(
          ...(await this.createKindTracks("video", constraints.video)),
        );
      }
      return new MediaStream(tracks);
    } catch (error) {
      for (const track of tracks) {
        track.stop();
      }
      throw error;
    }
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

  private async prepareRegisters() {
    await Promise.all(
      this.registers.map(async (register) => {
        try {
          await register.prepare?.();
        } catch {
          this.failedRegisters.add(register);
        }
      }),
    );
  }

  private async createKindTracks(
    kind: MediaKind,
    constraints: boolean | MediaTrackConstraints,
  ) {
    const available = this.registers.filter(
      (register) => !this.failedRegisters.has(register),
    );
    try {
      const selected = selectRegisterForKind(
        kind,
        constraints as boolean | PolyfillTrackConstraints,
        available,
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
    } catch (error) {
      const failedForKind = this.registers.some(
        (register) =>
          this.failedRegisters.has(register) && register.kinds.includes(kind),
      );
      if (failedForKind) {
        if (
          error instanceof DOMException &&
          error.name === "NotReadableError"
        ) {
          throw error;
        }
        throw createWebRtcDomException(
          "NotReadableError",
          error instanceof Error
            ? error.message
            : "Failed to read media source",
        );
      }
      throw mapGetUserMediaError(error);
    }
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

function mapGetUserMediaError(error: unknown): never {
  if (error instanceof OverconstrainedError || error instanceof TypeError) {
    throw error;
  }
  if (error instanceof DOMException) {
    throw error;
  }
  throw createWebRtcDomException(
    "AbortError",
    error instanceof Error ? error.message : "The operation was aborted",
  );
}
