import type { MediaStreamTrack } from "../media/track";
import type { MediaKind } from "./selectSettings";

export type { MediaKind };

export interface MediaTrackConstraints {
  deviceId?: unknown;
  groupId?: unknown;
  mimeType?: unknown;
  width?: unknown;
  height?: unknown;
  frameRate?: unknown;
  facingMode?: unknown;
  advanced?: MediaTrackConstraints[];
  [key: string]: unknown;
}

export interface MediaStreamConstraints {
  audio?: boolean | MediaTrackConstraints;
  video?: boolean | MediaTrackConstraints;
}

export interface MediaGetUserMediaRequest {
  kind: MediaKind;
  deviceId: string;
  constraints: MediaTrackConstraints;
  /** Uninstall / abort of the owning MediaDevices. Registers should stop in-flight I/O. */
  signal?: AbortSignal;
}

export interface MediaRegister {
  readonly mimeType: string;
  /**
   * Per-kind selection placeholders when one register serves multiple kinds.
   * `getUserMedia` matching uses this for the requested kind; it is not copied
   * onto `track.codec`.
   */
  readonly mimeTypeByKind?: Partial<Readonly<Record<MediaKind, string>>>;
  readonly kinds: readonly MediaKind[];
  readonly deviceId?: string;
  readonly groupId?: string;
  readonly label?: string;
  createTracks(request: MediaGetUserMediaRequest): Promise<MediaStreamTrack[]>;
  prepare?(): Promise<void>;
  stop?(): void;
}

export interface BoundMediaRegister extends MediaRegister {
  readonly deviceId: string;
}

export interface MediaRegisterCommonOptions {
  deviceId?: string;
  groupId?: string;
  label?: string;
}

export function mimeTypeForKind(
  register: Pick<MediaRegister, "mimeType" | "mimeTypeByKind">,
  kind: MediaKind,
): string {
  return register.mimeTypeByKind?.[kind] ?? register.mimeType;
}

export function normalizeTrackConstraints(
  constraints: boolean | MediaTrackConstraints,
): MediaTrackConstraints {
  if (constraints === true) {
    return {};
  }
  return { ...constraints };
}
