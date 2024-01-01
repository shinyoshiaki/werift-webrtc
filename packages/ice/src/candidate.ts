import { createHash } from "crypto";
import { isIPv4 } from "net";
import range from "lodash/range";

export class Candidate {
  // An ICE candidate.

  constructor(
    public foundation: string,
    public component: number,
    public transport: string,
    public priority: number,
    public host: string,
    public port: number,
    public type: string,
    public relatedAddress?: string,
    public relatedPort?: number,
    public tcptype?: string,
    public generation?: number,
  ) {}

  static fromSdp(sdp: string) {
    // Parse a :class:`Candidate` from SDP.
    // .. code-block:: python
    //    Candidate.from_sdp(
    //     '6815297761 1 udp 659136 1.2.3.4 31102 typ host generation 0')

    const bits = sdp.split(" ");
    if (bits.length < 8) throw new Error("SDP does not have enough properties");

    const kwargs = {
      foundation: bits[0],
      component: Number(bits[1]),
      transport: bits[2],
      priority: Number(bits[3]),
      host: bits[4],
      port: Number(bits[5]),
      type: bits[7],
    };

    for (const i of range(8, bits.length - 1, 2)) {
      if (bits[i] === "raddr") {
        (kwargs as any)["related_address"] = bits[i + 1];
      } else if (bits[i] === "rport") {
        (kwargs as any)["related_port"] = Number(bits[i + 1]);
      } else if (bits[i] === "tcptype") {
        (kwargs as any)["tcptype"] = bits[i + 1];
      } else if (bits[i] === "generation") {
        (kwargs as any)["generation"] = Number(bits[i + 1]);
      }
    }
    const { foundation, component, transport, priority, host, port, type } =
      kwargs;

    return new Candidate(
      foundation,
      component,
      transport,
      priority,
      host,
      port,
      type,
      (kwargs as any)["related_address"],
      (kwargs as any)["related_port"],
      (kwargs as any)["tcptype"],
      (kwargs as any)["generation"],
    );
  }

  canPairWith(other: Candidate) {
    // """
    // A local candidate is paired with a remote candidate if and only if
    // the two candidates have the same component ID and have the same IP
    // address version.
    // """
    const a = isIPv4(this.host);
    const b = isIPv4(other.host);
    return (
      this.component === other.component &&
      this.transport.toLowerCase() === other.transport.toLowerCase() &&
      a === b
    );
  }

  toSdp() {
    let sdp = `${this.foundation} ${this.component} ${this.transport} ${this.priority} ${this.host} ${this.port} typ ${this.type}`;

    if (this.relatedAddress) sdp += ` raddr ${this.relatedAddress}`;
    if (this.relatedPort != undefined) sdp += ` rport ${this.relatedPort}`;
    if (this.tcptype) sdp += ` tcptype ${this.tcptype}`;
    if (this.generation != undefined) sdp += ` generation ${this.generation}`;

    return sdp;
  }
}

export function candidateFoundation(
  candidateType: string,
  candidateTransport: string,
  baseAddress: string,
) {
  // """
  // See RFC 5245 - 4.1.1.3. Computing Foundations
  // """
  const key = `${candidateType}|${candidateTransport}|${baseAddress}`;

  return createHash("md5").update(key, "ascii").digest("hex").slice(7);
}

// priorityを決める
export function candidatePriority(
  candidateComponent: number,
  candidateType: string,
  localPref = 65535,
) {
  // See RFC 5245 - 4.1.2.1. Recommended Formula
  let typePref = 0;
  if (candidateType === "host") {
    typePref = 126;
  } else if (candidateType === "prflx") {
    typePref = 110;
  } else if (candidateType === "srflx") {
    typePref = 100;
  } else {
    typePref = 0;
  }
  return (
    (1 << 24) * typePref + (1 << 8) * localPref + (256 - candidateComponent)
  );
}
