import { parsePacket, parsePlainText } from "./record/receive";
import { HandshakeType } from "./handshake/const";
import { FragmentedHandshake } from "./record/message/fragment";
import { ContentType } from "./record/const";
import { ClientHello } from "./handshake/message/client/hello";
import { flight2 } from "./flight/server/flight2";
import { Flight4 } from "./flight/server/flight4";
import { Flight6 } from "./flight/server/flight6";
import { SessionType } from "./cipher/suites/abstract";
import { DtlsSocket, Options } from "./socket";
import debug from "debug";

const log = debug("werift/dtls/server");

export class DtlsServer extends DtlsSocket {
  constructor(options: Options) {
    super(options, SessionType.SERVER);
    this.udp.socket.onData = this.udpOnMessage;
    log("start server", options);
  }

  private udpOnMessage = (data: Buffer) => {
    const packets = parsePacket(data);

    for (const packet of packets) {
      const message = parsePlainText(this.dtls, this.cipher)(packet);
      switch (message.type) {
        case ContentType.handshake:
          {
            const handshake = message.data as FragmentedHandshake;
            const handshakes = this.handleFragmentHandshake([handshake]);
            const assembled = Object.values(
              handshakes
                .filter((v) => v.msg_type != undefined)
                .reduce(
                  (acc: { [type: string]: FragmentedHandshake[] }, cur) => {
                    if (!acc[cur.msg_type]) acc[cur.msg_type] = [];
                    acc[cur.msg_type].push(cur);
                    return acc;
                  },
                  {}
                )
            )
              .map((v) => FragmentedHandshake.assemble(v))
              .sort((a, b) => a.msg_type - b.msg_type);

            this.handleHandshakes(assembled);
          }
          break;
        case ContentType.applicationData:
          {
            this.onData.execute(message.data as Buffer);
          }
          break;
        case ContentType.alert:
          this.onClose.execute();
          break;
      }
    }
  };

  private flight6: Flight6;
  private handleHandshakes(assembled: FragmentedHandshake[]) {
    log("handleHandshakes", assembled);

    for (const handshake of assembled) {
      switch (handshake.msg_type) {
        case HandshakeType.client_hello:
          {
            const clientHello = ClientHello.deSerialize(handshake.fragment);

            if (
              this.dtls.cookie &&
              clientHello.cookie.equals(this.dtls.cookie)
            ) {
              log("send flight4");
              new Flight4(this.udp, this.dtls, this.cipher, this.srtp).exec(
                handshake,
                this.options.certificateRequest
              );
            } else if (!this.dtls.cookie) {
              log("send flight2");
              flight2(this.udp, this.dtls, this.cipher, this.srtp)(clientHello);
            }
          }
          break;
        case HandshakeType.client_key_exchange:
          {
            this.flight6 = new Flight6(this.udp, this.dtls, this.cipher);
            this.flight6.handleHandshake(handshake);
          }
          break;
        case HandshakeType.finished:
          {
            this.flight6.handleHandshake(handshake);
            this.flight6.exec();

            this.onConnect.execute();
            log("dtls connected");
          }
          break;
      }
    }
  }
}
