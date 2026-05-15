import { createHash, randomUUID } from "crypto";
import { isIPv4 } from "net";

export type TcpCandidateType = "active" | "passive" | "so";

export class Candidate {
  // An ICE candidate.
  id = randomUUID().toString();

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
    public ufrag?: string,
  ) {}

  refreshId() {
    this.id = randomUUID().toString();
  }

  static fromSdp(sdp: string) {
    // Parse a :class:`Candidate` from SDP.
    // .. code-block:: python
    //    Candidate.from_sdp(
    //     '6815297761 1 udp 659136 1.2.3.4 31102 typ host generation 0 ufrag b7l3')

    const bits = sdp.split(" ");
    if (bits.length < 8) {
      throw new Error("SDP does not have enough properties");
    }

    // 固定ワード
    const kwargs = {
      foundation: bits[0],
      component: Number(bits[1]),
      transport: bits[2],
      priority: Number(bits[3]),
      host: bits[4],
      port: Number(bits[5]),
      type: bits[7],
    };

    for (let i = 8, il = bits.length - 1; i < il; i += 2) {
      if (bits[i] === "raddr") {
        (kwargs as any)["related_address"] = bits[i + 1];
      } else if (bits[i] === "rport") {
        (kwargs as any)["related_port"] = Number(bits[i + 1]);
      } else if (bits[i] === "tcptype") {
        (kwargs as any)["tcptype"] = bits[i + 1];
      } else if (bits[i] === "generation") {
        (kwargs as any)["generation"] = Number(bits[i + 1]);
      } else if (bits[i] === "ufrag") {
        (kwargs as any)["ufrag"] = bits[i + 1];
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
      (kwargs as any)["ufrag"],
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
      canPairTcpCandidates(this, other) &&
      a === b
    );
  }

  toSdp() {
    let sdp = `${this.foundation} ${this.component} ${this.transport} ${this.priority} ${this.host} ${this.port} typ ${this.type}`;

    if (this.relatedAddress) sdp += ` raddr ${this.relatedAddress}`;
    if (this.relatedPort != undefined) sdp += ` rport ${this.relatedPort}`;
    if (this.tcptype) sdp += ` tcptype ${this.tcptype}`;
    if (this.generation != undefined) sdp += ` generation ${this.generation}`;
    if (this.ufrag != undefined) sdp += ` ufrag ${this.ufrag}`;

    return sdp;
  }
}

const UDP_TYPE_PREFERENCE: Record<string, number> = {
  host: 126,
  prflx: 110,
  srflx: 100,
  relay: 0,
};

const TCP_TYPE_PREFERENCE: Record<string, number> = {
  host: 105,
  prflx: 90,
  srflx: 80,
  relay: 0,
};

const ACTIVE_PASSIVE_DIRECTION_PREFERENCE: Record<TcpCandidateType, number> = {
  active: 6,
  passive: 4,
  so: 2,
};

const REFLEXIVE_DIRECTION_PREFERENCE: Record<TcpCandidateType, number> = {
  active: 4,
  passive: 2,
  so: 6,
};

function normalizeTransport(transport?: string) {
  return transport?.toLowerCase() ?? "udp";
}

function normalizeTcpType(tcptype?: string) {
  switch (tcptype) {
    case "active":
    case "passive":
    case "so":
      return tcptype;
    default:
      return undefined;
  }
}

function canPairTcpCandidates(local: Candidate, remote: Candidate) {
  if (normalizeTransport(local.transport) !== "tcp") {
    return true;
  }

  const localType = normalizeTcpType(local.tcptype);
  const remoteType = normalizeTcpType(remote.tcptype);
  if (!localType || !remoteType) {
    return false;
  }

  return (
    (localType === "active" && remoteType === "passive") ||
    (localType === "passive" && remoteType === "active") ||
    (localType === "so" && remoteType === "so")
  );
}

export function candidateLocalPreference({
  candidateType,
  transport = "udp",
  tcptype,
  otherPreference = 8191,
}: {
  candidateType: string;
  transport?: string;
  tcptype?: string;
  otherPreference?: number;
}) {
  if (normalizeTransport(transport) !== "tcp") {
    return otherPreference;
  }

  const tcpType = normalizeTcpType(tcptype) ?? "active";
  const directionPreference =
    candidateType === "srflx" || candidateType === "prflx"
      ? REFLEXIVE_DIRECTION_PREFERENCE[tcpType]
      : ACTIVE_PASSIVE_DIRECTION_PREFERENCE[tcpType];

  return (1 << 13) * directionPreference + otherPreference;
}

function candidateTypePreference(candidateType: string, transport = "udp") {
  const table =
    normalizeTransport(transport) === "tcp"
      ? TCP_TYPE_PREFERENCE
      : UDP_TYPE_PREFERENCE;
  return table[candidateType] ?? 0;
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
  candidateType: string,
  options:
    | number
    | {
        transport?: string;
        tcptype?: string;
        localPreference?: number;
        otherPreference?: number;
      } = 65535,
) {
  const candidateComponent: number = 1;
  // See RFC 5245 - 4.1.2.1. Recommended Formula
  const transport =
    typeof options === "number" ? "udp" : normalizeTransport(options.transport);
  const localPref =
    typeof options === "number"
      ? options
      : (options.localPreference ??
        candidateLocalPreference({
          candidateType,
          transport,
          tcptype: options.tcptype,
          otherPreference: options.otherPreference,
        }));
  const typePref = candidateTypePreference(candidateType, transport);
  return (
    (1 << 24) * typePref + (1 << 8) * localPref + (256 - candidateComponent)
  );
}

export function remoteTcpTypeForIncoming(
  localTcpType?: string,
): TcpCandidateType {
  switch (localTcpType) {
    case "passive":
      return "active";
    case "active":
      return "passive";
    default:
      return "so";
  }
}
