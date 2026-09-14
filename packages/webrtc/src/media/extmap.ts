import { RTCRtpHeaderExtensionParameters } from "./parameters";

/** RFC 8285 reserved SDP offer/answer negotiation IDs. */
export const EXTMAP_NEGOTIATION_ID_MIN = 4096;
export const EXTMAP_NEGOTIATION_ID_MAX = 4351;
const EXTMAP_ONE_BYTE_ID_MAX = 14;
const EXTMAP_TWO_BYTE_ID_MAX = 255;

export const EXTMAP_DIRECTIONS = [
  "sendonly",
  "recvonly",
  "sendrecv",
  "inactive",
] as const;

export type ExtmapDirection = (typeof EXTMAP_DIRECTIONS)[number];

export type ExtmapDescriptor = {
  id: number;
  uri: string;
  attributes?: string;
  direction?: string;
};

export function isExtmapNegotiationId(id: number): boolean {
  return id >= EXTMAP_NEGOTIATION_ID_MIN && id <= EXTMAP_NEGOTIATION_ID_MAX;
}

export function isExtmapDirection(value: string): value is ExtmapDirection {
  return (EXTMAP_DIRECTIONS as readonly string[]).includes(value);
}

export function extmapMediaDirection(direction?: string): ExtmapDirection {
  return direction && isExtmapDirection(direction) ? direction : "sendrecv";
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

export function assertExtmapCompatibleWithMedia(
  extension: ExtmapDescriptor,
  mediaDirection: ExtmapDirection,
) {
  if (
    extension.direction != undefined &&
    !isExtmapDirection(extension.direction)
  ) {
    throw new Error(`invalid extmap direction ${extension.direction}`);
  }
  const effective = extension.direction ?? mediaDirection;
  const mediaSend =
    mediaDirection === "sendonly" || mediaDirection === "sendrecv";
  const mediaRecv =
    mediaDirection === "recvonly" || mediaDirection === "sendrecv";
  if (effective === "sendonly" && !mediaSend) {
    throw new Error("extmap direction contradicts media direction");
  }
  if (effective === "recvonly" && !mediaRecv) {
    throw new Error("extmap direction contradicts media direction");
  }
  if (effective === "sendrecv" && mediaDirection !== "sendrecv") {
    throw new Error("extmap direction contradicts media direction");
  }
  if (mediaDirection === "inactive" && effective !== "inactive") {
    throw new Error("extmap direction contradicts media direction");
  }
}

export function isValidAnswerExtmapDirection(
  offered: ExtmapDirection,
  answered: ExtmapDirection,
): boolean {
  switch (offered) {
    case "sendrecv":
      return true;
    case "sendonly":
      return answered === "recvonly" || answered === "inactive";
    case "recvonly":
      return answered === "sendonly" || answered === "inactive";
    case "inactive":
      return answered === "inactive";
  }
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

export type LocalExtmapAllocator = {
  usedIds: Set<number>;
  configToId: Map<string, number>;
};

/**
 * Assign local extmap IDs per RTP session. Identity is URI + attributes;
 * direction is not part of the key. Conflicting seed IDs are skipped so a
 * later assign can pick a free ID.
 */
export function createLocalExtmapAllocator(
  seed: Iterable<ExtmapDescriptor> = [],
): LocalExtmapAllocator {
  const allocator: LocalExtmapAllocator = {
    usedIds: new Set(),
    configToId: new Map(),
  };
  for (const extension of seed) {
    seedLocalExtmapId(allocator, extension);
  }
  return allocator;
}

function seedLocalExtmapId(
  allocator: LocalExtmapAllocator,
  extension: ExtmapDescriptor,
) {
  if (
    !Number.isInteger(extension.id) ||
    extension.id < 1 ||
    isExtmapNegotiationId(extension.id)
  ) {
    return;
  }
  const key = extmapConfigurationKey(extension);
  if (allocator.configToId.has(key) || allocator.usedIds.has(extension.id)) {
    return;
  }
  allocator.usedIds.add(extension.id);
  allocator.configToId.set(key, extension.id);
}

export function assignLocalExtmapId(
  allocator: LocalExtmapAllocator,
  extension: ExtmapDescriptor,
): number {
  const key = extmapConfigurationKey(extension);
  const existing = allocator.configToId.get(key);
  if (existing != undefined) {
    return existing;
  }
  const id = allocateUsableExtmapId(allocator.usedIds);
  allocator.usedIds.add(id);
  allocator.configToId.set(key, id);
  return id;
}

export function assignLocalExtmapIds(
  extensions: ExtmapDescriptor[],
  allocator: LocalExtmapAllocator,
): RTCRtpHeaderExtensionParameters[] {
  return extensions.map((extension) =>
    cloneHeaderExtension(extension, {
      id: assignLocalExtmapId(allocator, extension),
    }),
  );
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
 * Remote answers must reuse the pending local offer's valid-range mapping.
 * Direction may change within RFC 8285/3264; 4096–4351 stay out of the live map.
 */
export function selectAnswerHeaderExtensions(
  remote: ExtmapDescriptor[],
  offered: ExtmapDescriptor[],
  supportedUris: ReadonlySet<string>,
  remoteMediaDirection: ExtmapDirection = "sendrecv",
  offeredMediaDirection: ExtmapDirection = "sendrecv",
): RTCRtpHeaderExtensionParameters[] {
  const offeredByKey = new Map(
    offered
      .filter((extension) => !isExtmapNegotiationId(extension.id))
      .map((extension) => [extmapConfigurationKey(extension), extension]),
  );
  const selected: RTCRtpHeaderExtensionParameters[] = [];
  for (const extension of remote) {
    if (isExtmapNegotiationId(extension.id)) continue;

    const offeredExtension = offeredByKey.get(
      extmapConfigurationKey(extension),
    );
    if (!offeredExtension) {
      throw new Error(`answer extmap ${extension.uri} was not offered`);
    }
    if (offeredExtension.id !== extension.id) {
      throw new Error(
        `answer remapped extmap ${extension.uri} from id ${offeredExtension.id} to ${extension.id}`,
      );
    }
    const offeredEffective = extmapMediaDirection(
      offeredExtension.direction ?? offeredMediaDirection,
    );
    const answeredEffective = extmapMediaDirection(
      extension.direction ?? remoteMediaDirection,
    );
    if (!isValidAnswerExtmapDirection(offeredEffective, answeredEffective)) {
      throw new Error(
        `answer extmap direction ${answeredEffective} is not valid for offered ${offeredEffective}`,
      );
    }
    if (supportedUris.has(extension.uri)) {
      selected.push(cloneHeaderExtension(extension));
    }
  }
  return selected;
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
