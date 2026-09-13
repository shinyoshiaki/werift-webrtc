import { RTCRtpHeaderExtensionParameters } from "./parameters";

/** RFC 8285 reserved SDP offer/answer negotiation IDs. */
export const EXTMAP_NEGOTIATION_ID_MIN = 4096;
export const EXTMAP_NEGOTIATION_ID_MAX = 4351;
const EXTMAP_ONE_BYTE_ID_MAX = 14;
const EXTMAP_TWO_BYTE_ID_MAX = 255;

export type ExtmapDescriptor = {
  id: number;
  uri: string;
  attributes?: string;
  direction?: string;
};

export function isExtmapNegotiationId(id: number): boolean {
  return id >= EXTMAP_NEGOTIATION_ID_MIN && id <= EXTMAP_NEGOTIATION_ID_MAX;
}

export function extmapConfigurationKey(extension: ExtmapDescriptor): string {
  return `${extension.uri}\n${(extension.attributes ?? "").trim()}`;
}

export function reverseExtmapDirection(direction?: string): string | undefined {
  if (direction === "sendonly") return "recvonly";
  if (direction === "recvonly") return "sendonly";
  return direction;
}

export function cloneHeaderExtension(
  extension: ExtmapDescriptor,
  overrides: Partial<RTCRtpHeaderExtensionParameters> = {},
): RTCRtpHeaderExtensionParameters {
  return new RTCRtpHeaderExtensionParameters({
    id: extension.id,
    uri: extension.uri,
    ...(extension.attributes ? { attributes: extension.attributes } : {}),
    ...(extension.direction ? { direction: extension.direction } : {}),
    ...overrides,
  });
}

export type ExtmapNegotiationState = {
  usedIds: Set<number>;
  chosenByNegotiationId: Map<number, { id: number; key: string }>;
};

export function createExtmapNegotiationState(
  usedIds: Iterable<number> = [],
): ExtmapNegotiationState {
  return {
    usedIds: new Set([...usedIds].filter((id) => !isExtmapNegotiationId(id))),
    chosenByNegotiationId: new Map(),
  };
}

function allocateUsableExtmapId(usedIds: Set<number>): number {
  for (let id = 1; id <= EXTMAP_ONE_BYTE_ID_MAX; id++) {
    if (!usedIds.has(id)) return id;
  }
  for (
    let id = EXTMAP_ONE_BYTE_ID_MAX + 1;
    id <= EXTMAP_TWO_BYTE_ID_MAX;
    id++
  ) {
    if (!usedIds.has(id)) return id;
  }
  throw new Error("no free RTP header extension id");
}

/**
 * Filter to locally supported URIs, pick at most one RFC 8285 alternative per
 * negotiation ID, and remap 4096–4351 onto a free live RTP ID.
 */
export function negotiateRemoteHeaderExtensions(
  remote: ExtmapDescriptor[],
  supportedUris: ReadonlySet<string>,
  state: ExtmapNegotiationState,
): RTCRtpHeaderExtensionParameters[] {
  const negotiated: RTCRtpHeaderExtensionParameters[] = [];
  for (const extension of remote) {
    if (!supportedUris.has(extension.uri)) continue;
    if (!isExtmapNegotiationId(extension.id)) {
      state.usedIds.add(extension.id);
      negotiated.push(cloneHeaderExtension(extension));
      continue;
    }

    const chosen = state.chosenByNegotiationId.get(extension.id);
    if (chosen) {
      if (chosen.key === extmapConfigurationKey(extension)) {
        negotiated.push(cloneHeaderExtension(extension, { id: chosen.id }));
      }
      continue;
    }

    const id = allocateUsableExtmapId(state.usedIds);
    state.usedIds.add(id);
    state.chosenByNegotiationId.set(extension.id, {
      id,
      key: extmapConfigurationKey(extension),
    });
    negotiated.push(cloneHeaderExtension(extension, { id }));
  }
  return negotiated;
}

/**
 * Remote answers must not remap 4096–4351; only valid-range IDs are live.
 */
export function selectAnswerHeaderExtensions(
  remote: ExtmapDescriptor[],
  supportedUris: ReadonlySet<string>,
): RTCRtpHeaderExtensionParameters[] {
  return remote
    .filter(
      (extension) =>
        supportedUris.has(extension.uri) &&
        !isExtmapNegotiationId(extension.id),
    )
    .map((extension) => cloneHeaderExtension(extension));
}

export function seedExtmapUsedIds(
  state: ExtmapNegotiationState,
  extensions: ExtmapDescriptor[],
) {
  for (const extension of extensions) {
    if (!isExtmapNegotiationId(extension.id)) {
      state.usedIds.add(extension.id);
    }
  }
}
