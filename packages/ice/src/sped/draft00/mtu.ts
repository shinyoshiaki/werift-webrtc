import {
  FINGERPRINT_LENGTH,
  HEADER_LENGTH,
  INTEGRITY_LENGTH,
  classes,
  methods,
} from "../../stun/const";
import { Message, paddingLength } from "../../stun/message";

import { SPED_ACK_MAX, SPED_OUTER_MTU } from "./constants";

/**
 * Bytes still available for a DTLS-IN-STUN-DATA *value* (and its STUN padding)
 * once ACK, DATA header, HMAC-SHA1 MESSAGE-INTEGRITY, and FINGERPRINT are
 * reserved on a Binding that does not yet include those attributes.
 */
export function remainingDataValueBudget(
  message: Message,
  ackValue: Buffer,
  outerLimit = SPED_OUTER_MTU,
): number {
  const current = message.bytes.length;
  const ackAttr = 4 + ackValue.length + paddingLength(ackValue.length);
  const dataHeader = 4;
  const reserved = ackAttr + dataHeader + INTEGRITY_LENGTH + FINGERPRINT_LENGTH;
  return outerLimit - current - reserved;
}

/** Largest payload n such that n + STUN padding(n) <= budget. */
export function maxPayloadFitting(budget: number): number {
  if (budget <= 0) {
    return 0;
  }
  for (let n = budget; n >= 0; n--) {
    if (n + paddingLength(n) <= budget) {
      return n;
    }
  }
  return 0;
}

export function estimatedStunSizeAfterSped(
  messageWithoutIntegrity: Message,
  ackValue: Buffer,
  dataValue: Buffer,
  outerLimit = SPED_OUTER_MTU,
): number {
  const current = messageWithoutIntegrity.bytes.length;
  const ackAttr = 4 + ackValue.length + paddingLength(ackValue.length);
  const dataAttr = 4 + dataValue.length + paddingLength(dataValue.length);
  return current + ackAttr + dataAttr + INTEGRITY_LENGTH + FINGERPRINT_LENGTH;
}

export function stunFitsPathMtu(
  size: number,
  outerLimit = SPED_OUTER_MTU,
): boolean {
  return size <= outerLimit;
}

export type SpedMtuIceCredentials = {
  localUsername: string;
  remoteUsername: string;
  /** Response XOR-MAPPED-ADDRESS uses IPv6 (larger) when true. */
  useIpv6?: boolean;
};

function maxAckValue() {
  return Buffer.alloc(SPED_ACK_MAX * 4);
}

/**
 * Controlling Binding Request with USE-CANDIDATE (larger of the two roles)
 * and the actual ICE USERNAME (`remote:local`).
 */
export function spedBindingRequestSkeleton(
  credentials: SpedMtuIceCredentials,
): Message {
  const local = credentials.localUsername || "yyyyyyyy";
  const remote = credentials.remoteUsername || "xxxxxxxx";
  const skeleton = new Message(methods.BINDING, classes.REQUEST);
  skeleton
    .setAttribute("USERNAME", `${remote}:${local}`)
    .setAttribute("PRIORITY", 0x7fffffff)
    .setAttribute("ICE-CONTROLLING", 0xffffffffffffffffn)
    .setAttribute("USE-CANDIDATE", null);
  return skeleton;
}

/** Binding Response with XOR-MAPPED-ADDRESS (IPv6 when {@link SpedMtuIceCredentials.useIpv6}). */
export function spedBindingResponseSkeleton(
  credentials: SpedMtuIceCredentials,
): Message {
  const skeleton = new Message(methods.BINDING, classes.RESPONSE);
  const mapped: [string, number] = credentials.useIpv6
    ? ["2001:db8::1", 3478]
    : ["192.0.2.1", 3478];
  skeleton.setAttribute("XOR-MAPPED-ADDRESS", mapped);
  return skeleton;
}

function dtlsMtuForSkeleton(
  skeleton: Message,
  outerLimit = SPED_OUTER_MTU,
): number {
  return Math.max(
    1,
    maxPayloadFitting(
      remainingDataValueBudget(skeleton, maxAckValue(), outerLimit),
    ),
  );
}

/**
 * DTLS datagram MTU = min(Request budget, Response budget) with actual
 * ICE ufrags, max ACK, and HMAC-SHA1 MI/FP reserved.
 */
export function spedDtlsMtuForIceCredentials(
  credentials: SpedMtuIceCredentials,
  outerLimit = SPED_OUTER_MTU,
): number {
  return Math.max(
    1,
    Math.min(
      dtlsMtuForSkeleton(spedBindingRequestSkeleton(credentials), outerLimit),
      dtlsMtuForSkeleton(spedBindingResponseSkeleton(credentials), outerLimit),
    ),
  );
}

/**
 * Conservative DTLS datagram MTU for SPED (RFC 8831 1200 minus Table 1
 * HMAC-SHA1 Binding overhead, including a 4-CRC ACK and USE-CANDIDATE).
 * Prefer {@link spedDtlsMtuForIceCredentials} once ICE ufrags are known.
 */
export function defaultSpedDtlsMtu(outerLimit = SPED_OUTER_MTU): number {
  return spedDtlsMtuForIceCredentials(
    { localUsername: "yyyyyyyy", remoteUsername: "xxxxxxxx", useIpv6: true },
    outerLimit,
  );
}

export { HEADER_LENGTH, SPED_ACK_MAX, SPED_OUTER_MTU };
