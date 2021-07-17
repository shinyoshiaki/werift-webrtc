import debug from "debug";

import { SessionType } from "./cipher/suites/abstract";
import { Flight1 } from "./flight/client/flight1";
import { Flight3 } from "./flight/client/flight3";
import { Flight5 } from "./flight/client/flight5";
import { HandshakeType } from "./handshake/const";
import { ServerHelloVerifyRequest } from "./handshake/message/server/helloVerifyRequest";
import { FragmentedHandshake } from "./record/message/fragment";
import { DtlsSocket, Options } from "./socket";

const log = debug("werift:packages/dtls/src/client.ts");

export class DtlsClient extends DtlsSocket {
  constructor(options: Options) {
    super(options, SessionType.CLIENT);
    this.onHandleHandshakes = this.handleHandshakes;
    log("start client");
  }

  async connect() {
    await new Flight1(this.transport, this.dtls, this.cipher).exec(
      this.extensions
    );
  }

  private flight5!: Flight5;
  private handleHandshakes = async (assembled: FragmentedHandshake[]) => {
    log("handleHandshakes", assembled);

    for (const handshake of assembled) {
      switch (handshake.msg_type) {
        case HandshakeType.hello_verify_request:
          {
            const verifyReq = ServerHelloVerifyRequest.deSerialize(
              handshake.fragment
            );
            await new Flight3(this.transport, this.dtls).exec(verifyReq);
          }
          break;
        case HandshakeType.server_hello:
          {
            this.flight5 = new Flight5(
              this.transport,
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
            await this.flight5.exec();
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
  };
}
