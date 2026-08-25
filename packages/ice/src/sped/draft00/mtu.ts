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

/**
 * Conservative DTLS datagram MTU for SPED (RFC 8831 1200 minus Table 1
 * HMAC-SHA1 Binding overhead, including a 4-CRC ACK and USE-CANDIDATE).
 */
export function defaultSpedDtlsMtu(outerLimit = SPED_OUTER_MTU): number {
  const skeleton = new Message(methods.BINDING, classes.REQUEST);
  skeleton
    .setAttribute("USERNAME", "xxxxxxxx:yyyyyyyy")
    .setAttribute("PRIORITY", 0x7fffffff)
    .setAttribute("ICE-CONTROLLING", 0xffffffffffffffffn)
    .setAttribute("USE-CANDIDATE", null);
  const ackValue = Buffer.alloc(SPED_ACK_MAX * 4);
  return Math.max(
    1,
    maxPayloadFitting(remainingDataValueBudget(skeleton, ackValue, outerLimit)),
  );
}

export { HEADER_LENGTH, SPED_ACK_MAX, SPED_OUTER_MTU };
