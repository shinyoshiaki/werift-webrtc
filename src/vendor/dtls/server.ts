import { parsePacket } from "./record/receive";
import { HandshakeType } from "./handshake/const";
import { FragmentedHandshake } from "./record/message/fragment";
import { ContentType } from "./record/const";
import { ClientHello } from "./handshake/message/client/hello";
import { flight2 } from "./flight/server/flight2";
import { Flight4 } from "./flight/server/flight4";
import { Flight6 } from "./flight/server/flight6";
import { SessionType } from "./cipher/suites/abstract";
import { DtlsSocket, Options } from "./socket";

export class DtlsServer extends DtlsSocket {
  constructor(options: Options) {
    super(options, false);
    this.cipher.certPem = options.cert;
    this.cipher.keyPem = options.key;
    this.cipher.sessionType = SessionType.SERVER;
    this.udp.socket.onData = this.udpOnMessage;
  }

  private udpOnMessage = (data: Buffer) => {
    const messages = parsePacket(this.dtls, this.cipher)(data);
    if (messages.length === 0) return;
    switch (messages[0].type) {
      case ContentType.handshake:
        {
          this.handleHandshakes(
            messages.map((v) => v.data as FragmentedHandshake).filter((v) => v)
          );
        }
        break;
      case ContentType.applicationData:
        {
          this.onData(messages[0].data as Buffer);
        }
        break;
      case ContentType.alert:
        this.onClose();
        break;
    }
  };

  private handleHandshakes(handshakes: FragmentedHandshake[]) {
    switch (handshakes[0].msg_type) {
      case HandshakeType.client_hello:
        {
          const assemble = FragmentedHandshake.assemble(handshakes);
          const clientHello = ClientHello.deSerialize(assemble.fragment);

          if (this.dtls.cookie && this.dtls.cookie.equals(clientHello.cookie)) {
            this.dtls.bufferHandshakeCache([assemble], false, 4);

            new Flight4(this.udp, this.dtls, this.cipher, this.srtp).exec(
              this.options.certificateRequest
            );
          } else {
            flight2(this.udp, this.dtls, this.cipher, this.srtp)(clientHello);
          }
        }
        break;
      case HandshakeType.client_key_exchange:
        {
          new Flight6(this.udp, this.dtls, this.cipher).exec(handshakes);
          if (this.onConnect) this.onConnect();
        }
        break;
    }
  }
}
