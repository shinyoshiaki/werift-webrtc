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

/** RFC 8285 one- and two-byte RTP header extension IDs (1–255). */
export function isExtmapLiveId(id: number): boolean {
  return Number.isInteger(id) && id >= 1 && id <= EXTMAP_TWO_BYTE_ID_MAX;
}

export function isExtmapDirection(value: string): value is ExtmapDirection {
  return (EXTMAP_DIRECTIONS as readonly string[]).includes(value);
}

export function extmapMediaDirection(direction?: string): ExtmapDirection {
  return direction && isExtmapDirection(direction) ? direction : "sendrecv";
}

/**
 * RFC 8285: an omitted extmap direction inherits the media direction, except
 * inactive media inherits sendrecv.
 */
export function inheritedExtmapDirection(
  mediaDirection: ExtmapDirection,
): ExtmapDirection {
  return mediaDirection === "inactive" ? "sendrecv" : mediaDirection;
}

export function effectiveExtmapDirection(
  extension: ExtmapDescriptor,
  mediaDirection: ExtmapDirection,
): ExtmapDirection {
  if (extension.direction) {
    if (!isExtmapDirection(extension.direction)) {
      throw new Error(`invalid extmap direction ${extension.direction}`);
    }
    return extension.direction;
  }
  return inheritedExtmapDirection(mediaDirection);
}

export function extmapConfigurationKey(extension: ExtmapDescriptor): string {
  return `${extension.uri}\n${(extension.attributes ?? "").trim()}`;
}

export function reverseExtmapDirection(direction?: string): string | undefined {
  if (direction === "sendonly") return "recvonly";
  if (direction === "recvonly") return "sendonly";
  return direction;
}

function intersectExtmapDirection(
  left: ExtmapDirection,
  right: ExtmapDirection,
): ExtmapDirection {
  const order = ["inactive", "sendonly", "recvonly", "sendrecv"] as const;
  return order[order.indexOf(left) & order.indexOf(right)]!;
}

/**
 * Project a stored local-perspective extmap direction onto the m-line that
 * will actually be advertised. Qualifier is omitted when it matches RFC 8285
 * inheritance.
 */
export function projectExtmapDirectionForMedia(
  stored: string | undefined,
  mediaDirection: ExtmapDirection,
): ExtmapDirection | undefined {
  const inherited = inheritedExtmapDirection(mediaDirection);
  const effective =
    stored && isExtmapDirection(stored) ? stored : inherited;
  const projected =
    mediaDirection === "inactive"
      ? effective === "inactive"
        ? "inactive"
        : "sendrecv"
      : intersectExtmapDirection(effective, mediaDirection);
  return projected === inherited ? undefined : projected;
}

/**
 * Answer projection must honor the offered effective direction. Inactive
 * media inherits sendrecv when the qualifier is omitted, so a recvonly or
 * sendonly offer cannot be answered with an omitted qualifier.
 */
export function projectExtmapDirectionForAnswer(
  stored: string | undefined,
  mediaDirection: ExtmapDirection,
  offeredEffective: ExtmapDirection,
): ExtmapDirection | undefined {
  const inherited = inheritedExtmapDirection(mediaDirection);
  const localFromOffer = reverseExtmapDirection(offeredEffective);
  const storedEffective =
    stored && isExtmapDirection(stored)
      ? stored
      : localFromOffer && isExtmapDirection(localFromOffer)
        ? localFromOffer
        : inherited;

  let projected: ExtmapDirection;
  if (mediaDirection === "inactive") {
    projected =
      offeredEffective === "sendrecv" && storedEffective !== "inactive"
        ? "sendrecv"
        : "inactive";
  } else {
    projected = intersectExtmapDirection(storedEffective, mediaDirection);
  }

  if (!isValidAnswerExtmapDirection(offeredEffective, projected)) {
    projected = "inactive";
  }

  return projected === inherited ? undefined : projected;
}

export function projectHeaderExtensionsForMedia(
  extensions: ExtmapDescriptor[],
  mediaDirection: ExtmapDirection,
  offeredEffectiveByKey?: ReadonlyMap<string, ExtmapDirection>,
): RTCRtpHeaderExtensionParameters[] {
  return extensions.map((extension) => {
    const offeredEffective = offeredEffectiveByKey?.get(
      extmapConfigurationKey(extension),
    );
    const direction =
      offeredEffective != undefined
        ? projectExtmapDirectionForAnswer(
            extension.direction,
            mediaDirection,
            offeredEffective,
          )
        : projectExtmapDirectionForMedia(extension.direction, mediaDirection);
    return cloneHeaderExtension(extension, { direction });
  });
}

export function cloneHeaderExtension(
  extension: ExtmapDescriptor,
  overrides: Partial<RTCRtpHeaderExtensionParameters> = {},
): RTCRtpHeaderExtensionParameters {
  const { direction: directionOverride, ...rest } = overrides;
  const direction = Object.hasOwn(overrides, "direction")
    ? directionOverride
    : extension.direction;
  return new RTCRtpHeaderExtensionParameters({
    id: extension.id,
    uri: extension.uri,
    ...(extension.attributes ? { attributes: extension.attributes } : {}),
    ...rest,
    ...(direction ? { direction } : {}),
  });
}

export function assertExtmapCompatibleWithMedia(
  extension: ExtmapDescriptor,
  mediaDirection: ExtmapDirection,
) {
  const effective = effectiveExtmapDirection(extension, mediaDirection);
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
  if (
    effective === "sendrecv" &&
    mediaDirection !== "sendrecv" &&
    mediaDirection !== "inactive"
  ) {
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
  idToConfig: Map<number, string>;
};

function hasStableExtmapId(id: number) {
  return isExtmapLiveId(id);
}

/**
 * Assign local extmap IDs per RTP session. Identity is URI + attributes;
 * direction is not part of the key. Last-stable IDs are never remapped: a
 * BUNDLE ID-space conflict omits the later extension instead.
 */
export function createLocalExtmapAllocator(
  seed: Iterable<ExtmapDescriptor> = [],
): LocalExtmapAllocator {
  const allocator: LocalExtmapAllocator = {
    usedIds: new Set(),
    configToId: new Map(),
    idToConfig: new Map(),
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
  if (!hasStableExtmapId(extension.id)) {
    return;
  }
  const key = extmapConfigurationKey(extension);
  if (allocator.configToId.has(key) || allocator.usedIds.has(extension.id)) {
    return;
  }
  allocator.usedIds.add(extension.id);
  allocator.configToId.set(key, extension.id);
  allocator.idToConfig.set(extension.id, key);
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
  allocator.idToConfig.set(id, key);
  return id;
}

export function assignLocalExtmapIds(
  extensions: ExtmapDescriptor[],
  allocator: LocalExtmapAllocator,
): RTCRtpHeaderExtensionParameters[] {
  const assigned: RTCRtpHeaderExtensionParameters[] = [];
  for (const extension of extensions) {
    const next = keepOrAssignLocalExtmap(allocator, extension);
    if (next) assigned.push(next);
  }
  return assigned;
}

function keepOrAssignLocalExtmap(
  allocator: LocalExtmapAllocator,
  extension: ExtmapDescriptor,
): RTCRtpHeaderExtensionParameters | undefined {
  const key = extmapConfigurationKey(extension);
  if (hasStableExtmapId(extension.id)) {
    const mappedId = allocator.configToId.get(key);
    const owner = allocator.idToConfig.get(extension.id);
    if (owner != undefined && owner !== key) {
      return undefined;
    }
    if (mappedId != undefined && mappedId !== extension.id) {
      return undefined;
    }
    allocator.usedIds.add(extension.id);
    allocator.configToId.set(key, extension.id);
    allocator.idToConfig.set(extension.id, key);
    return cloneHeaderExtension(extension);
  }
  return cloneHeaderExtension(extension, {
    id: assignLocalExtmapId(allocator, extension),
  });
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
 * Remote answers must reuse the pending local offer's mapping. Valid-range IDs
 * are live; 4096–4351 stay out of the live map but must still match the offer.
 */
export function selectAnswerHeaderExtensions(
  remote: ExtmapDescriptor[],
  offered: ExtmapDescriptor[],
  supportedUris: ReadonlySet<string>,
  remoteMediaDirection: ExtmapDirection = "sendrecv",
  offeredMediaDirection: ExtmapDirection = "sendrecv",
): RTCRtpHeaderExtensionParameters[] {
  const offeredByConfig = new Map(
    offered
      .filter((extension) => isExtmapLiveId(extension.id))
      .map((extension) => [extmapConfigurationKey(extension), extension]),
  );
  const offeredNegotiation = new Map(
    offered
      .filter((extension) => isExtmapNegotiationId(extension.id))
      .map((extension) => [extmapNegotiationKey(extension), extension]),
  );
  const offeredNegotiationByConfig = new Map(
    offered
      .filter((extension) => isExtmapNegotiationId(extension.id))
      .map((extension) => [extmapConfigurationKey(extension), extension]),
  );
  const selected: RTCRtpHeaderExtensionParameters[] = [];
  for (const extension of remote) {
    if (isExtmapNegotiationId(extension.id)) {
      if (!offeredNegotiation.has(extmapNegotiationKey(extension))) {
        throw new Error(`answer extmap ${extension.uri} was not offered`);
      }
      continue;
    }
    const key = extmapConfigurationKey(extension);
    const offeredLive = offeredByConfig.get(key);
    const offeredNegotiated = offeredNegotiationByConfig.get(key);
    const offeredExtension = offeredLive ?? offeredNegotiated;
    if (!offeredExtension) {
      throw new Error(`answer extmap ${extension.uri} was not offered`);
    }
    if (offeredLive && offeredLive.id !== extension.id) {
      throw new Error(
        `answer remapped extmap ${extension.uri} from id ${offeredLive.id} to ${extension.id}`,
      );
    }
    if (!offeredLive && offeredNegotiated && !isExtmapLiveId(extension.id)) {
      throw new Error(
        `answer remapped extmap ${extension.uri} from id ${offeredNegotiated.id} to ${extension.id}`,
      );
    }
    const offeredEffective = effectiveExtmapDirection(
      offeredExtension,
      offeredMediaDirection,
    );
    const answeredEffective = effectiveExtmapDirection(
      extension,
      remoteMediaDirection,
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

function extmapNegotiationKey(extension: ExtmapDescriptor): string {
  return `${extension.id}\n${extmapConfigurationKey(extension)}`;
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
