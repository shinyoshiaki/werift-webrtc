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
  private readonly disposeAbort = new AbortController();
  private disposed = false;

  constructor(private readonly registers: BoundMediaRegister[]) {
    super();
  }

  getSupportedConstraints() {
    return { ...polyfillSupportedConstraints };
  }

  async enumerateDevices(): Promise<MediaDeviceInfoLike[]> {
    this.throwIfDisposed();
    await this.prepareRegisters();
    this.throwIfDisposed();
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
    this.throwIfDisposed();
    assertRequestedMediaTypes(constraints);
    await this.prepareRegisters();
    this.throwIfDisposed();
    const tracks: MediaStreamTrack[] = [];
    try {
      if (constraints.audio) {
        tracks.push(
          ...(await this.createKindTracks("audio", constraints.audio)),
        );
      }
      this.throwIfDisposed();
      if (constraints.video) {
        tracks.push(
          ...(await this.createKindTracks("video", constraints.video)),
        );
      }
      this.throwIfDisposed();
      for (const track of tracks) {
        this.watchTrack(track);
      }
      return new MediaStream(tracks);
    } catch (error) {
      for (const track of tracks) {
        track.stop();
      }
      if (this.disposed) {
        throw abortedException();
      }
      throw error;
    }
  };

  getDisplayMedia = this.getUserMedia;

  cleanup() {
    this.disposed = true;
    this.disposeAbort.abort();
    for (const stop of this.activeStops.values()) {
      stop();
    }
    this.activeStops.clear();
    for (const register of this.registers) {
      register.stop?.();
    }
  }

  private async prepareRegisters() {
    this.throwIfDisposed();
    await Promise.all(
      this.registers.map(async (register) => {
        try {
          this.throwIfDisposed();
          await register.prepare?.();
          this.throwIfDisposed();
        } catch (error) {
          if (this.disposed || isAbortError(error)) {
            throw abortedException();
          }
          this.failedRegisters.add(register);
        }
      }),
    );
  }

  private async createKindTracks(
    kind: MediaKind,
    constraints: boolean | MediaTrackConstraints,
  ) {
    this.throwIfDisposed();
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
        signal: this.disposeAbort.signal,
      });
      if (this.disposed) {
        for (const track of tracks) {
          track.stop();
        }
        throw abortedException();
      }
      return tracks;
    } catch (error) {
      if (this.disposed || isAbortError(error)) {
        throw abortedException();
      }
      if (this.shouldSurfacePrepareFailure(kind, available)) {
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

  private shouldSurfacePrepareFailure(
    kind: MediaKind,
    available: BoundMediaRegister[],
  ) {
    const availableForKind = available.some((register) =>
      register.kinds.includes(kind),
    );
    if (availableForKind) {
      return false;
    }
    return this.registers.some(
      (register) =>
        this.failedRegisters.has(register) && register.kinds.includes(kind),
    );
  }

  private watchTrack(track: MediaStreamTrack) {
    const originalStop = track.stop;
    track.stop = () => {
      this.activeStops.delete(track);
      originalStop.call(track);
    };
    this.activeStops.set(track, () => track.stop());
  }

  private throwIfDisposed() {
    if (this.disposed) {
      throw abortedException();
    }
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

function abortedException() {
  return createWebRtcDomException("AbortError", "The operation was aborted");
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
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
