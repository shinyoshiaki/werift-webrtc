import { SrtpSession } from "../../vendor/rtp/srtp/srtp";
import Event from "rx.mini";
import { RtpHeader, RtpPacket } from "../../vendor/rtp/rtp/rtp";
import { SrtcpSession } from "../../vendor/rtp/srtp/srtcp";
import { RtcpPacket, RtcpPacketConverter } from "../../vendor/rtp/rtcp/rtcp";
import { RTCDtlsTransport } from "./dtls";

export class RTCSrtpTransport {
  srtp: SrtpSession;
  onSrtp = new Event<RtpPacket>();
  srtcp: SrtcpSession;
  onSrtcp = new Event<RtcpPacket[]>();

  constructor(public dtlsTransport: RTCDtlsTransport) {
    const dtls = dtlsTransport.dtls;
    const {
      localKey,
      localSalt,
      remoteKey,
      remoteSalt,
    } = dtls.extractSessionKeys();

    this.srtp = new SrtpSession({
      keys: {
        localMasterKey: localKey,
        localMasterSalt: localSalt,
        remoteMasterKey: remoteKey,
        remoteMasterSalt: remoteSalt,
      },
      profile: dtls.srtp.srtpProfile,
    });

    this.dtlsTransport.iceTransport.connection.onData.subscribe((data) => {
      if (!isMedia(data)) return;
      if (isRtcp(data)) {
        const dec = this.srtcp.decrypt(data);
        const srtcp = RtcpPacketConverter.deSerialize(dec);
        this.onSrtcp.execute(srtcp);
      } else {
        const dec = this.srtp.decrypt(data);
        const rtp = RtpPacket.deSerialize(dec);
        this.onSrtp.execute(rtp);
      }
    });
  }

  sendRtp(header: RtpHeader, rawRtp: Buffer) {
    const enc = this.srtp.encrypt(header, rawRtp);
    this.dtlsTransport.iceTransport.connection.send(enc);
  }

  sendRtcp(packets: RtcpPacket[]) {
    const payload = Buffer.concat(packets.map((packet) => packet.serialize()));
    this.srtcp.encrypt(payload);
  }
}

function isMedia(data: Buffer) {
  return data[0] > 127 && data[0] < 192;
}

function isRtcp(buf: Buffer) {
  return buf.length >= 2 && buf[1] >= 192 && buf[1] <= 208;
}

class RtpRouter {}
