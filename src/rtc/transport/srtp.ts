import { SrtpSession } from "../../vendor/rtp/srtp/srtp";
import Event from "rx.mini";
import { RtpHeader } from "../../vendor/rtp/rtp/rtp";
import { SrtcpSession } from "../../vendor/rtp/srtp/srtcp";
import { RtcpPacket } from "../../vendor/rtp/rtcp/rtcp";
import { RTCDtlsTransport } from "./dtls";

export class RTCSrtpTransport {
  srtp: SrtpSession;
  onSrtp = new Event<Buffer>();
  srtcp: SrtcpSession;
  onSrtcp = new Event<Buffer>();

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
      const dec = this.srtp.decrypt(data);
      this.onSrtp.execute(dec);
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
