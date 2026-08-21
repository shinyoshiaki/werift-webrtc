import { AlertDesc } from "../../record/const";
import { DtlsProtocolError } from "../../version";

/**
 * RFC 8446 / RFC 5246: There MUST NOT be more than one extension of the
 * same type in a given extension block.
 */
export function assertUniqueExtensions(
  extensions: { type: number }[],
  context: string,
): void {
  const seen = new Set<number>();
  for (const e of extensions) {
    if (seen.has(e.type)) {
      throw new DtlsProtocolError(
        `illegal_parameter: duplicate extension 0x${e.type.toString(16)} in ${context}`,
        AlertDesc.IllegalParameter,
      );
    }
    seen.add(e.type);
  }
}
