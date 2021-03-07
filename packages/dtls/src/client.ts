import { Flight1 } from "./flight/client/flight1";
import { parsePacket, parsePlainText } from "./record/receive";
import { ServerHelloVerifyRequest } from "./handshake/message/server/helloVerifyRequest";
import { Flight3 } from "./flight/client/flight3";
import { HandshakeType } from "./handshake/const";
import { Flight5 } from "./flight/client/flight5";
import { FragmentedHandshake } from "./record/message/fragment";
import { ContentType } from "./record/const";
import { SessionType } from "./cipher/suites/abstract";
import { DtlsSocket, Options } from "./socket";
import debug from "debug";

const log = debug("werift/dtls/client");

export class DtlsClient extends DtlsSocket {
  constructor(options: Options) {
    super(options, SessionType.CLIENT);
    this.udp.socket.onData = this.udpOnMessage;
    log("start client", options);
  }

  connect() {
    new Flight1(this.udp, this.dtls, this.cipher).exec(this.extensions);
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

  private flight5!: Flight5;
  private handleHandshakes(assembled: FragmentedHandshake[]) {
    log("handleHandshakes", assembled);

    for (const handshake of assembled) {
      switch (handshake.msg_type) {
        case HandshakeType.hello_verify_request:
          {
            const verifyReq = ServerHelloVerifyRequest.deSerialize(
              handshake.fragment
            );
            new Flight3(this.udp, this.dtls).exec(verifyReq);
          }
          break;
        case HandshakeType.server_hello:
          {
            this.flight5 = new Flight5(
              this.udp,
              this.dtls,
              this.cipher,
              this.srtp
            );
            this.flight5.handleHandshake(handshake);
          }
          break;
        case HandshakeType.certificate:
        case HandshakeType.server_key_exchange:
        case HandshakeType.certificate_request:
          {
            this.flight5.handleHandshake(handshake);
          }
          break;
        case HandshakeType.server_hello_done:
          {
            this.flight5.handleHandshake(handshake);
            this.flight5.exec();
          }
          break;
        case HandshakeType.finished:
          {
            this.dtls.flight = 7;
            this.onConnect.execute();
            log("dtls connected");
          }
          break;
      }
    }
  }
}
