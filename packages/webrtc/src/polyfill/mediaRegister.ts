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
}

export interface MediaRegister {
  readonly mimeType: string;
  readonly kinds: readonly MediaKind[];
  readonly deviceId?: string;
  readonly groupId?: string;
  readonly label?: string;
  createTracks(request: MediaGetUserMediaRequest): Promise<MediaStreamTrack[]>;
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

export function normalizeTrackConstraints(
  constraints: boolean | MediaTrackConstraints,
): MediaTrackConstraints {
  if (constraints === true) {
    return {};
  }
  return { ...constraints };
}
