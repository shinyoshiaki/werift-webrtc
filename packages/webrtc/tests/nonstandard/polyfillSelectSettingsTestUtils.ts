import type {
  MediaKind,
  MediaRegisterCandidate,
} from "../../src/polyfill/selectSettings";

export function createPolyfillRegisterCandidates(
  entries: Array<{
    deviceId: string;
    mimeType: string;
    kinds: readonly MediaKind[];
    groupId?: string;
  }>,
): MediaRegisterCandidate[] {
  return entries.map((entry) => ({
    deviceId: entry.deviceId,
    mimeType: entry.mimeType,
    kinds: entry.kinds,
    groupId: entry.groupId,
  }));
}
