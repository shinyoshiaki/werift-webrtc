import type { Message } from "./message";

/**
 * Look up a comprehension-optional raw STUN attribute by type.
 * Package-private: not re-exported from ice-server / ice barrels.
 */
export function getRawAttributeValue(
  message: Message,
  type: number,
): Buffer | undefined {
  const attribute = message.rawAttributes.find((entry) => entry.type === type);
  return attribute?.value;
}
