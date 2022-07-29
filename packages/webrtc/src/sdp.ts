import { randomBytes } from 'crypto';
import { Uint64BE } from 'int64-buffer';
import range from 'lodash/range';
import { isIPv4 } from 'net';

import { DTLS_ROLE_SETUP, DTLS_SETUP_ROLE, FMTP_INT_PARAMETERS, SSRC_INFO_ATTRS } from './const';
import { divide } from './helper';
import {
  RTCRtcpFeedback,
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpParameters,
  RTCRtpSimulcastParameters,
} from './media/parameters';
import { Direction } from './media/rtpTransceiver';
import { DtlsRole, RTCDtlsFingerprint, RTCDtlsParameters } from './transport/dtls';
import { IceCandidate, RTCIceParameters } from './transport/ice';
import { RTCSctpCapabilities } from './transport/sctp';
import { Kind } from './types/domain';

export class SessionDescription {
  version = 0;
  origin?: string;
  name = '-';
  time = '0 0';
  host?: string;
  group: GroupDescription[] = [];
  extMapAllowMixed = true;
  msidSemantic: GroupDescription[] = [];
  media: MediaDescription[] = [];
  type!: 'offer' | 'answer';
  dtlsRole!: DtlsRole;
  iceOptions!: string;
  iceLite!: boolean;
  icePassword!: string;
  iceUsernameFragment!: string;
  dtlsFingerprints: RTCDtlsFingerprint[] = [];

  static parse(sdp: string) {
    const [sessionLines, mediaGroups] = groupLines(sdp);

    const session = new SessionDescription();
    sessionLines.forEach((line) => {
      if (line.startsWith('v=')) {
        session.version = parseInt(line.slice(2), 10);
      } else if (line.startsWith('o=')) {
        session.origin = line.slice(2);
      } else if (line.startsWith('s=')) {
        session.name = line.slice(2);
      } else if (line.startsWith('c=')) {
        session.host = ipAddressFromSdp(line.slice(2));
      } else if (line.startsWith('t=')) {
        session.time = line.slice(2);
      } else if (line.startsWith('a=')) {
        const [attr, value] = parseAttr(line);
        switch (attr) {
          case 'fingerprint':
            const [algorithm, fingerprint] = value?.split(' ') || [];
            session.dtlsFingerprints.push(new RTCDtlsFingerprint(algorithm, fingerprint));
            break;
          case 'ice-lite':
            session.iceLite = true;
            break;
          case 'ice-options':
            session.iceOptions = value;
            break;
          case 'ice-pwd':
            session.icePassword = value;
            break;
          case 'ice-ufrag':
            session.iceUsernameFragment = value;
            break;
          case 'group':
            parseGroup(session.group, value);
            break;
          case 'msid-semantic':
            parseGroup(session.msidSemantic, value);
            break;
          case 'setup':
            session.dtlsRole = DTLS_SETUP_ROLE[value];
            break;
          case 'extmap-allow-mixed':
            session.extMapAllowMixed = true;
            break;
        }
      }
    });

    mediaGroups.forEach((mediaLines) => {
      const target = mediaLines[0];
      const m = target.match(/^m=([^ ]+) ([0-9]+) ([A-Z/]+) (.+)/);
      if (!m) {
        throw new Error('m line not found');
      }

      const kind = m[1] as Kind;
      const fmt = m[4].split(' ');
      // todo fix
      const fmtInt = ['audio', 'video'].includes(kind) ? fmt.map((v) => Number(v)) : undefined;

      const currentMedia = new MediaDescription(kind, parseInt(m[2]), m[3], fmtInt || fmt);
      currentMedia.dtlsParams = new RTCDtlsParameters(
        [...session.dtlsFingerprints],
        session.dtlsRole
      );
      currentMedia.iceParams = new RTCIceParameters({
        iceLite: session.iceLite,
        usernameFragment: session.iceUsernameFragment,
        password: session.icePassword,
      });
      currentMedia.iceOptions = session.iceOptions;
      session.media.push(currentMedia);

      mediaLines.slice(1).forEach((line) => {
        if (line.startsWith('c=')) {
          currentMedia.host = ipAddressFromSdp(line.slice(2));
        } else if (line.startsWith('a=')) {
          const [attr, value] = parseAttr(line);

          switch (attr) {
            case 'candidate':
              if (!value) throw new Error();
              currentMedia.iceCandidates.push(candidateFromSdp(value));
              break;
            case 'end-of-candidates':
              currentMedia.iceCandidatesComplete = true;
              break;
            case 'extmap':
              // eslint-disable-next-line prefer-const
              let [extId, extUri] = value.split(' ');
              if (extId.includes('/')) {
                [extId] = extId.split('/');
              }
              currentMedia.rtp.headerExtensions.push(
                new RTCRtpHeaderExtensionParameters({
                  id: parseInt(extId),
                  uri: extUri,
                })
              );
              break;
            case 'fingerprint':
              if (!value) throw new Error();
              const [algorithm, fingerprint] = value.split(' ');
              currentMedia.dtlsParams?.fingerprints.push(
                new RTCDtlsFingerprint(algorithm, fingerprint)
              );
              break;
            case 'ice-options':
              currentMedia.iceOptions = value;
              break;
            case 'ice-pwd':
              currentMedia.iceParams!.password = value;
              break;
            case 'ice-ufrag':
              currentMedia.iceParams!.usernameFragment = value;
              break;
            case 'ice-lite':
              currentMedia.iceParams!.iceLite = true;
              break;
            case 'max-message-size':
              currentMedia.sctpCapabilities = new RTCSctpCapabilities(parseInt(value, 10));
              break;
            case 'mid':
              currentMedia.rtp.muxId = value;
              break;
            case 'msid':
              currentMedia.msid = value;
              break;
            case 'rtcp':
              const [port, rest] = divide(value, ' ');
              currentMedia.rtcpPort = parseInt(port);
              currentMedia.rtcpHost = ipAddressFromSdp(rest);
              break;
            case 'rtcp-mux':
              currentMedia.rtcpMux = true;
              break;
            case 'setup':
              currentMedia.dtlsParams!.role = DTLS_SETUP_ROLE[value];
              break;
            case 'recvonly':
            case 'sendonly':
            case 'sendrecv':
            case 'inactive':
              currentMedia.direction = attr;
              break;
            case 'rtpmap':
              {
                const [formatId, formatDesc] = divide(value, ' ');
                const [type, clock, channel] = formatDesc.split('/');
                let channels: number | undefined;
                if (currentMedia.kind === 'audio') {
                  channels = channel ? parseInt(channel) : 1;
                }
                const codec = new RTCRtpCodecParameters({
                  mimeType: currentMedia.kind + '/' + type,
                  channels,
                  clockRate: parseInt(clock),
                  payloadType: parseInt(formatId),
                });
                currentMedia.rtp.codecs.push(codec);
              }
              break;
            case 'sctpmap':
              if (!value) throw new Error();
              const [formatId, formatDesc] = divide(value, ' ');
              currentMedia.sctpMap[parseInt(formatId)] = formatDesc;
              currentMedia.sctpPort = parseInt(formatId);
              break;
            case 'sctp-port':
              if (!value) throw new Error();
              currentMedia.sctpPort = parseInt(value);
              break;
            case 'ssrc':
              const [ssrcStr, ssrcDesc] = divide(value, ' ');
              const ssrc = parseInt(ssrcStr);
              const [ssrcAttr, ssrcValue] = divide(ssrcDesc, ':');
              let ssrcInfo = currentMedia.ssrc.find((v) => v.ssrc === ssrc);
              if (!ssrcInfo) {
                ssrcInfo = new SsrcDescription({ ssrc });
                currentMedia.ssrc.push(ssrcInfo);
              }
              if (SSRC_INFO_ATTRS.includes(ssrcAttr)) {
                ssrcInfo[ssrcAttr] = ssrcValue;
              }
              break;
            case 'ssrc-group':
              parseGroup(currentMedia.ssrcGroup, value);
              break;
            case 'rid':
              {
                const [rid, direction] = divide(value, ' ');

                currentMedia.simulcastParameters.push(
                  new RTCRtpSimulcastParameters({
                    rid,
                    direction: direction as any,
                  })
                );
              }
              break;
          }
        }
      });

      if (!currentMedia.dtlsParams.role) {
        currentMedia.dtlsParams = undefined;
      }

      const findCodec = (pt: number) => currentMedia.rtp.codecs.find((v) => v.payloadType === pt);

      mediaLines.slice(1).forEach((line) => {
        if (line.startsWith('a=')) {
          const [attr, value] = parseAttr(line);
          if (attr === 'fmtp') {
            const [formatId, formatDesc] = divide(value, ' ');
            const codec = findCodec(Number(formatId))!;
            codec.parameters = formatDesc;
          } else if (attr === 'rtcp-fb') {
            const [payloadType, feedbackType, feedbackParam] = value.split(' ');
            currentMedia.rtp.codecs.forEach((codec) => {
              if (['*', codec.payloadType!.toString()].includes(payloadType)) {
                codec.rtcpFeedback.push(
                  new RTCRtcpFeedback({
                    type: feedbackType,
                    parameter: feedbackParam,
                  })
                );
              }
            });
          }
        }
      });
    });

    return session;
  }

  webrtcTrackId(media: MediaDescription) {
    if (media.msid && media.msid.includes(' ')) {
      const bits = media.msid.split(' ');
      for (const group of this.msidSemantic) {
        if (
          group.semantic === 'WMS' &&
          (group.items.includes(bits[0]) || group.items.includes('*'))
        ) {
          return bits[1];
        }
      }
    }
    return;
  }

  get string() {
    const lines = [`v=${this.version}`, `o=${this.origin}`, `s=${this.name}`];
    if (this.host) {
      lines.push(`c=${ipAddressFromSdp(this.host)}`);
    }
    lines.push(`t=${this.time}`);
    this.group.forEach((group) => lines.push(`a=group:${group.str}`));
    if (this.extMapAllowMixed) {
      lines.push(`a=extmap-allow-mixed`);
    }
    this.msidSemantic.forEach((group) => lines.push(`a=msid-semantic:${group.str}`));
    const media = this.media.map((m) => m.toString()).join('');
    const sdp = lines.join('\r\n') + '\r\n' + media;
    return sdp;
  }

  toJSON() {
    return new RTCSessionDescription(this.string, this.type);
  }
}

export class MediaDescription {
  // rtp
  host?: string;
  direction?: Direction;
  msid?: string;

  // rtcp
  rtcpPort?: number;
  rtcpHost?: string;
  rtcpMux = false;

  // ssrc
  ssrc: SsrcDescription[] = [];
  ssrcGroup: GroupDescription[] = [];

  // formats
  rtp: RTCRtpParameters = { codecs: [], headerExtensions: [] };

  // sctp
  sctpCapabilities?: RTCSctpCapabilities;
  sctpMap: { [key: number]: string } = {};
  sctpPort?: number;

  // DTLS
  dtlsParams?: RTCDtlsParameters;

  // ICE
  iceParams?: RTCIceParameters;
  iceCandidates: IceCandidate[] = [];
  iceCandidatesComplete = false;
  iceOptions?: string;

  // Simulcast
  simulcastParameters: RTCRtpSimulcastParameters[] = [];

  constructor(
    public kind: Kind,
    public port: number,
    public profile: string,
    public fmt: string[] | number[]
  ) {}

  toString() {
    const lines: string[] = [];
    lines.push(
      `m=${this.kind} ${this.port} ${this.profile} ${(this.fmt as number[])
        .map((v) => v.toString())
        .join(' ')}`
    );
    if (this.host) {
      lines.push(`c=${ipAddressToSdp(this.host)}`);
    }
    // ice
    this.iceCandidates.forEach((candidate) => {
      lines.push(`a=candidate:${candidateToSdp(candidate)}`);
    });
    if (this.iceCandidatesComplete) {
      lines.push('a=end-of-candidates');
    }
    if (this.iceParams?.usernameFragment) {
      lines.push(`a=ice-ufrag:${this.iceParams.usernameFragment}`);
    }
    if (this.iceParams?.password) {
      lines.push(`a=ice-pwd:${this.iceParams.password}`);
    }
    if (this.iceParams?.iceLite) {
      lines.push(`a=ice-lite`);
    }
    if (this.iceOptions) {
      lines.push(`a=ice-options:${this.iceOptions}`);
    }

    // dtls
    if (this.dtlsParams) {
      this.dtlsParams.fingerprints.forEach((fingerprint) => {
        lines.push(`a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`);
      });
      lines.push(`a=setup:${DTLS_ROLE_SETUP[this.dtlsParams.role]}`);
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

    if (this.rtcpPort && this.rtcpHost) {
      lines.push(`a=rtcp:${this.rtcpPort} ${ipAddressToSdp(this.rtcpHost)}`);
      if (this.rtcpMux) {
        lines.push('a=rtcp-mux');
      }
    }

    this.ssrcGroup.forEach((group) => {
      lines.push(`a=ssrc-group:${group.str}`);
    });
    this.ssrc.forEach((ssrcInfo) => {
      SSRC_INFO_ATTRS.forEach((ssrcAttr) => {
        const ssrcValue = ssrcInfo[ssrcAttr];
        if (ssrcValue !== undefined) {
          lines.push(`a=ssrc:${ssrcInfo.ssrc} ${ssrcAttr}:${ssrcValue}`);
        }
      });
    });

    this.rtp.codecs.forEach((codec) => {
      lines.push(`a=rtpmap:${codec.payloadType} ${codec.str}`);

      codec.rtcpFeedback.forEach((feedback) => {
        let value = feedback.type;
        if (feedback.parameter) value += ` ${feedback.parameter}`;
        lines.push(`a=rtcp-fb:${codec.payloadType} ${value}`);
      });

      if (codec.parameters) {
        lines.push(`a=fmtp:${codec.payloadType} ${codec.parameters}`);
      }
    });

    Object.keys(this.sctpMap).forEach((k) => {
      const v = this.sctpMap[Number(k)];
      lines.push(`a=sctpmap:${k} ${v}`);
    });
    if (this.sctpPort) {
      lines.push(`a=sctp-port:${this.sctpPort}`);
    }
    if (this.sctpCapabilities) {
      lines.push(`a=max-message-size:${this.sctpCapabilities.maxMessageSize}`);
    }

    // rtp extension
    this.rtp.headerExtensions.forEach((extension) =>
      lines.push(`a=extmap:${extension.id} ${extension.uri}`)
    );

    // simulcast
    if (this.simulcastParameters.length) {
      this.simulcastParameters.forEach((param) => {
        lines.push(`a=rid:${param.rid} ${param.direction}`);
      });
      let line = `a=simulcast:`;
      const recv = this.simulcastParameters.filter((v) => v.direction === 'recv');
      if (recv.length) {
        line += `recv ${recv.map((v) => v.rid).join(';')} `;
      }
      const send = this.simulcastParameters.filter((v) => v.direction === 'send');
      if (send.length) {
        line += `send ${send.map((v) => v.rid).join(';')}`;
      }

      lines.push(line);
    }

    return lines.join('\r\n') + '\r\n';
  }
}

export class GroupDescription {
  constructor(public semantic: string, public items: string[]) {}

  get str() {
    return `${this.semantic} ${this.items.join(' ')}`;
  }
}

function ipAddressFromSdp(sdp: string) {
  const m = sdp.match(/^IN (IP4|IP6) ([^ ]+)$/);
  if (!m) throw new Error('exception');
  return m[2];
}

function ipAddressToSdp(addr: string) {
  const version = isIPv4(addr) ? 4 : 6;
  return `IN IP${version} ${addr}`;
}

export function candidateToSdp(c: IceCandidate) {
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

function groupLines(sdp: string): [string[], string[][]] {
  const session: string[] = [];
  const media: string[][] = [];

  let lines = sdp.split('\r\n');
  if (lines.length === 1) {
    lines = sdp.split('\n');
  }

  lines.forEach((line) => {
    if (line.startsWith('m=')) {
      media.push([line]);
    } else if (media.length > 0) {
      media[media.length - 1].push(line);
    } else {
      session.push(line);
    }
  });

  return [session, media];
}

function parseAttr(line: string): [string, string] {
  if (line.includes(':')) {
    const bits = divide(line.slice(2), ':');
    return [bits[0], bits[1]];
  } else {
    return [line.slice(2), undefined as any];
  }
}

export function parseGroup(
  dest: GroupDescription[],
  value: string,
  type: (v: string) => any = (v) => v.toString()
) {
  const bits = value.split(' ');
  if (bits.length > 0) {
    dest.push(new GroupDescription(bits[0], bits.slice(1).map(type)));
  }
}

export function candidateFromSdp(sdp: string) {
  const bits = sdp.split(' ');
  if (bits.length < 8) {
    throw new Error();
  }

  const candidate = new IceCandidate(
    parseInt(bits[1], 10),
    bits[0],
    bits[4],
    parseInt(bits[5], 10),
    parseInt(bits[3], 10),
    bits[2],
    bits[7]
  );

  range(8, bits.length - 1, 2).forEach((i) => {
    switch (bits[i]) {
      case 'raddr':
        candidate.relatedAddress = bits[i + 1];
        break;
      case 'rport':
        candidate.relatedPort = parseInt(bits[i + 1]);
        break;
      case 'tcptype':
        candidate.tcpType = bits[i + 1];
        break;
    }
  });

  return candidate;
}

export class RTCSessionDescription {
  constructor(public sdp: string, public type: 'offer' | 'answer') {}
}

export function addSDPHeader(type: 'offer' | 'answer', description: SessionDescription) {
  const username = '-';
  const sessionId = new Uint64BE(randomBytes(64)).toString().slice(0, 8);
  const sessionVersion = 0;

  description.origin = `${username} ${sessionId} ${sessionVersion} IN IP4 0.0.0.0`;
  description.msidSemantic.push(new GroupDescription('WMS', ['*']));
  description.type = type;
}

export function codecParametersFromString(str: string) {
  const parameters = {};
  str.split(';').forEach((param) => {
    if (param.includes('=')) {
      const [k, v] = divide(param, '=');
      if (FMTP_INT_PARAMETERS.includes(k)) {
        parameters[k] = Number(v);
      } else {
        parameters[k] = v;
      }
    } else {
      parameters[param] = undefined;
    }
  });
  return parameters;
}

export function codecParametersToString(parameters: { [key: string]: string | number }) {
  const params = Object.entries(parameters).map(([k, v]) => {
    if (v) return `${k}=${v}`;
    else return k;
  });
  if (params.length > 0) {
    return params.join(';');
  }
  return undefined;
}

export class SsrcDescription {
  ssrc!: number;
  cname?: string;
  msid?: string;
  msLabel?: string;
  label?: string;

  constructor(props: Partial<SsrcDescription>) {
    Object.assign(this, props);
  }
}
