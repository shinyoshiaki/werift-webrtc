import { isIPv4, isIPv6 } from "net";

import type {
  RTCIceCandidateType,
  RTCIceTcpCandidateType,
} from "../media/stats";

export type RTCIceComponent = "rtp" | "rtcp";
export type RTCIceProtocol = "udp" | "tcp";

/**
 * The readonly fields `RTCIceCandidate` exposes from its candidate a-line.
 *
 * Validity contract shared by every path that produces them
 * (`new RTCIceCandidate(init)`, `RTCIceCandidate.fromSdp()`,
 * `IceCandidate.fromJSON()` / `IceCandidate.toJSON()` and therefore the
 * `icecandidate` event and `RTCIceTransport.getSelectedCandidatePair()` /
 * `getLocalCandidates()` / `getRemoteCandidates()`).
 *
 * 1. Grammar (RFC 8839 §5.1). The attribute value, with at most one leading
 *    `candidate:` removed, is split on single spaces; an empty token
 *    (leading / trailing / repeated space) or a token containing other
 *    whitespace is invalid. Elements:
 *
 *    | element | valid when |
 *    | --- | --- |
 *    | foundation | 1-32 `ice-char` (`A-Z a-z 0-9 + /`) |
 *    | component-id | integer 1-256 |
 *    | transport | non-empty token |
 *    | priority | integer 1-2^31-1 (RFC 8445 §5.1.2) |
 *    | connection-address | IPv4, IPv6 or FQDN (includes mDNS `.local`); a dotted all-digit name must be IPv4 |
 *    | port | integer 0-65535 |
 *    | `typ` + candidate-types | the literal `typ` followed by a non-empty token |
 *    | `raddr` | connection-address |
 *    | `rport` | integer 0-65535 |
 *    | `tcptype` | `active` / `passive` / `so` |
 *    | `generation` | non-negative integer |
 *    | other extension attributes | name and value tokens, in pairs (`network-id`, `network-cost`, `ufrag`, ...) |
 *
 *    A grammar violation makes the candidate unparsable: every field is `null`
 *    and `IceCandidate.fromJSON()` returns `undefined`, so
 *    `addIceCandidate()` rejects with `OperationError`.
 * 2. Mapping to the W3C attributes (constructor steps 4.2 / 4.3). If a parsed
 *    value cannot be represented by its attribute, parsing is aborted and every
 *    field is `null`: component-id other than 1 (`rtp`) / 2 (`rtcp`) (e.g. 3 is
 *    valid RFC 8839 but has no `RTCIceComponent`), transport other than
 *    `udp` / `tcp` (case-insensitive), or a candidate type other than
 *    `host` / `srflx` / `prflx` / `relay`.
 * 3. `tcpType` alone is `null` when `protocol` is not `tcp`
 *    (it is "null if protocol is not tcp", not an invalid value).
 *    `relatedAddress` / `relatedPort` are `null` when absent.
 *
 * 4. Candidates werift holds as typed values (`IceCandidate.toJSON()`, used by
 *    the `icecandidate` event and the `RTCIceTransport` getters) are checked
 *    with the same element validators instead of reparsing the string. a=candidate
 *    lines of a remote description keep using the description parser; for
 *    those the fields are validated from the values the ICE agent uses.
 *
 * Not adopted: the W3C constructor TypeError when both `sdpMid` and
 * `sdpMLineIndex` are null (werift keeps its convenience behavior; strict
 * checks belong in the WPT runner wrappers). `relayProtocol` and `url` are not
 * implemented.
 */
export interface RTCIceCandidateFields {
  foundation: string | null;
  component: RTCIceComponent | null;
  priority: number | null;
  address: string | null;
  protocol: RTCIceProtocol | null;
  port: number | null;
  type: RTCIceCandidateType | null;
  tcpType: RTCIceTcpCandidateType | null;
  relatedAddress: string | null;
  relatedPort: number | null;
}

/** Typed values of a candidate attribute, named like `IceCandidate`. */
export interface CandidateAttributeValues {
  foundation: string;
  component: number;
  protocol: string;
  priority: number;
  ip: string;
  port: number;
  type: string;
  relatedAddress?: string;
  relatedPort?: number;
  tcpType?: string;
  generation?: number;
  ufrag?: string;
}

export const emptyCandidateFields: Readonly<RTCIceCandidateFields> =
  Object.freeze({
    foundation: null,
    component: null,
    priority: null,
    address: null,
    protocol: null,
    port: null,
    type: null,
    tcpType: null,
    relatedAddress: null,
    relatedPort: null,
  });

const candidateTypes = ["host", "srflx", "prflx", "relay"] as const;
const tcpTypes = ["active", "passive", "so"] as const;

const isToken = (value: unknown): value is string =>
  typeof value === "string" && /^\S+$/.test(value);

const isUint = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;

const fqdnLabel = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const fqdn = new RegExp(
  `^(?=.{1,253}\\.?$)${fqdnLabel}(?:\\.${fqdnLabel})*\\.?$`,
);

/** The element validators of the grammar, applied to typed values. */
const isValid = {
  foundation: (v: unknown) =>
    typeof v === "string" && /^[A-Za-z0-9+/]{1,32}$/.test(v),
  component: (v: unknown) => isUint(v, 1, 256),
  protocol: isToken,
  priority: (v: unknown) => isUint(v, 1, 2 ** 31 - 1),
  address: (v: unknown) =>
    typeof v === "string" &&
    (isIPv4(v) || isIPv6(v) || (!/^[\d.]+$/.test(v) && fqdn.test(v))),
  port: (v: unknown) => isUint(v, 0, 65535),
  type: isToken,
  tcpType: (v: unknown) => tcpTypes.includes(v as RTCIceTcpCandidateType),
  generation: (v: unknown) => isUint(v, 0, Number.MAX_SAFE_INTEGER),
};

/** Check typed candidate values (e.g. an `IceCandidate`) against the grammar. */
export function isValidCandidateValues(c: CandidateAttributeValues): boolean {
  return (
    isValid.foundation(c.foundation) &&
    isValid.component(c.component) &&
    isValid.protocol(c.protocol) &&
    isValid.priority(c.priority) &&
    isValid.address(c.ip) &&
    isValid.port(c.port) &&
    isValid.type(c.type) &&
    (c.relatedAddress === undefined || isValid.address(c.relatedAddress)) &&
    (c.relatedPort === undefined || isValid.port(c.relatedPort)) &&
    (c.tcpType === undefined || isValid.tcpType(c.tcpType)) &&
    (c.generation === undefined || isValid.generation(c.generation)) &&
    (c.ufrag === undefined || isToken(c.ufrag))
  );
}

/** Decimal token to number; anything else becomes NaN and fails validation. */
const toNumber = (token: string) =>
  /^\d{1,16}$/.test(token) ? Number(token) : Number.NaN;

/**
 * Parse a candidate attribute (`candidate:` prefix optional) with the grammar
 * documented on {@link RTCIceCandidateFields}. Returns `undefined` when it is
 * unparsable.
 */
export function parseCandidateAttribute(
  raw: string,
): CandidateAttributeValues | undefined {
  if (typeof raw !== "string") return;
  const value = raw.startsWith("candidate:")
    ? raw.slice("candidate:".length)
    : raw;
  const bits = value.split(" ");
  if (bits.length < 8 || bits.length % 2 !== 0) return;
  if (!bits.every(isToken) || bits[6] !== "typ") return;

  const [foundation, component, protocol, priority, ip, port, , type] = bits;
  const values: CandidateAttributeValues = {
    foundation,
    component: toNumber(component),
    protocol,
    priority: toNumber(priority),
    ip,
    port: toNumber(port),
    type,
  };
  for (let i = 8; i < bits.length; i += 2) {
    const [name, attr] = [bits[i], bits[i + 1]];
    if (name === "raddr") values.relatedAddress = attr;
    else if (name === "rport") values.relatedPort = toNumber(attr);
    else if (name === "tcptype") values.tcpType = attr;
    else if (name === "generation") values.generation = toNumber(attr);
    else if (name === "ufrag") values.ufrag = attr;
  }
  return isValidCandidateValues(values) ? values : undefined;
}

/**
 * Map typed candidate values to the W3C attributes (rules 2 and 3 of
 * {@link RTCIceCandidateFields}). Invalid or unrepresentable values give all
 * `null`.
 */
export function candidateFieldsFromValues(
  c: CandidateAttributeValues | undefined,
): RTCIceCandidateFields {
  if (!c || !isValidCandidateValues(c)) return { ...emptyCandidateFields };
  const component =
    c.component === 1 ? "rtp" : c.component === 2 ? "rtcp" : undefined;
  const protocol = c.protocol.toLowerCase();
  const type = candidateTypes.find((t) => t === c.type);
  if (!component || (protocol !== "udp" && protocol !== "tcp") || !type) {
    return { ...emptyCandidateFields };
  }
  return {
    foundation: c.foundation,
    component,
    priority: c.priority,
    address: c.ip,
    protocol,
    port: c.port,
    type,
    tcpType:
      protocol === "tcp"
        ? (tcpTypes.find((t) => t === c.tcpType) ?? null)
        : null,
    relatedAddress: c.relatedAddress ?? null,
    relatedPort: c.relatedPort ?? null,
  };
}
