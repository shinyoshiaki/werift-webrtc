import { RTCRtpParameters } from "./parameters";
import { RTCIceParameters, RTCIceCandidate } from "./transport/ice";
import { RTCDtlsParameters } from "./transport/dtls";
import { RTCSctpCapabilities } from "./transport/sctp";
import { DTLS_ROLE_SETUP } from "./const";
import { isIPv4 } from "net";

export class SessionDescription {
  version = 0;
  origin?: string;
  name = "-";
  time = "0 0";
  host?: string;
  group: GroupDescription[] = [];
  msidSemantic: GroupDescription[] = [];
  media: MediaDescription[] = [];
  type?: string;

  toString() {
    const lines = [`v=${this.version}`, `o=${this.origin}`, `s=${this.name}`];
    if (this.host) {
      lines.concat([`c=${ipAddressFromSdp(this.host)}`]);
    }
    lines.concat([`t=${this.time}`]);
    this.group.forEach(group => lines.concat([`a=group:${group}`]));
    this.msidSemantic.forEach(group =>
      lines.concat([`a=msid-semantic:${group}`])
    );
    return lines.join("\r\n") + "\r\n" + this.media.map(m => m);
  }
}

export class MediaDescription {
  // rtp
  host?: string;
  direction?: string;
  msid?: string;

  // formats
  rtp = new RTCRtpParameters();

  // sctp
  sctpCapabilities?: RTCSctpCapabilities;
  sctpMap: { [key: number]: string } = {};
  sctpPort?: number;

  // DTLS
  dtls?: RTCDtlsParameters;

  // ICE
  ice = new RTCIceParameters();
  iceCandidates: RTCIceCandidate[] = [];
  iceCandidatesComplete = false;
  iceOptions?: string;
  constructor(
    public kind: string,
    public port: number,
    public profile: string,
    public fmt: string[]
  ) {}

  toString() {
    const lines = [];
    lines.push(
      `m=${this.kind} ${this.port} ${this.profile} ${this.fmt
        .map(v => v.toString())
        .join(" ")}`
    );
    if (this.host) {
      lines.push(`c=${ipAddressToSdp(this.host)}`);
    }
    if (this.direction) {
      lines.push(`a=${this.direction}`);
    }

    if (this.rtp.muxId) {
      lines.push(`a=mid:${this.rtp.muxId}`);
    }
    if (this.msid) {
      lines.push(`a=msid:${this.msid}`);
    }

    Object.keys(this.sctpMap).forEach(k => {
      const v = this.sctpMap[Number(k)];
      lines.push(`a=sctpmap:${k} ${v}`);
    });
    if (this.sctpPort) {
      lines.push(`a=sctp-port:${this.sctpPort}`);
    }
    if (this.sctpCapabilities) {
      lines.push(`a=max-message-size:${this.sctpCapabilities.maxMessageSize}`);
    }

    // ice
    this.iceCandidates.forEach(candidate => {
      lines.push(`a=candidate:${candidateToSdp(candidate)}`);
    });
    if (this.iceCandidatesComplete) {
      lines.push("a=end-of-candidates");
    }
    if (this.ice.usernameFragment) {
      lines.push(`a=ice-ufrag:${this.ice.usernameFragment}`);
    }
    if (this.ice.password) {
      lines.push(`a=ice-pwd:${this.ice.password}`);
    }
    if (this.iceOptions) {
      lines.push(`a=ice-options:${this.iceOptions}`);
    }

    // dtls
    if (this.dtls) {
      this.dtls.fingerprints.forEach(fingerprint => {
        lines.push(
          `a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`
        );
      });
      lines.push(`a=setup:${DTLS_ROLE_SETUP[this.dtls.role]}`);
    }

    return lines.join("\r\n") + "\r\n";
  }
}

export class GroupDescription {
  constructor(public semantic: string, public items: (number | string)[]) {}

  str() {
    return `${this.semantic} ${this.items.join(" ")}`;
  }
}

function ipAddressFromSdp(sdp: string) {
  const m = sdp.match(/^IN (IP4|IP6) ([^ ]+)$/);
  if (!m) throw new Error("exception");
  return Object.values(m.groups!)[2];
}

function ipAddressToSdp(addr: string) {
  const version = isIPv4(addr) ? 4 : 6;
  return `IN IP${version} ${addr}`;
}

function candidateToSdp(c: RTCIceCandidate) {
  let sdp = `${c.foundation} ${c.component} ${c.protocol} ${c.priority} ${c.ip} ${c.port} typ ${c.type}`;
  if (c.relatedAddress) {
    sdp += ` raddr ${c.relatedAddress}`;
  }
  if (c.relatedPort) {
    sdp += ` rport ${c.relatedPort}`;
  }
  if (c.tcpType) {
    sdp += ` tcptype ${c.tcpType}`;
  }
  return sdp;
}
