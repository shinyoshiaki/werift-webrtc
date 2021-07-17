import debug from "debug";

import { SessionType } from "./cipher/suites/abstract";
import { flight2 } from "./flight/server/flight2";
import { Flight4 } from "./flight/server/flight4";
import { Flight6 } from "./flight/server/flight6";
import { HandshakeType } from "./handshake/const";
import { ClientHello } from "./handshake/message/client/hello";
import { FragmentedHandshake } from "./record/message/fragment";
import { DtlsSocket, Options } from "./socket";

const log = debug("werift/dtls/server");

export class DtlsServer extends DtlsSocket {
  constructor(options: Options) {
    super(options, SessionType.SERVER);
    this.onHandleHandshakes = this.handleHandshakes;
    log("start server", options);
  }

  private flight6!: Flight6;
  private handleHandshakes = async (assembled: FragmentedHandshake[]) => {
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
              await new Flight4(
                this.transport,
                this.dtls,
                this.cipher,
                this.srtp
              ).exec(handshake, this.options.certificateRequest);
            } else if (!this.dtls.cookie) {
              log("send flight2");
              flight2(
                this.transport,
                this.dtls,
                this.cipher,
                this.srtp
              )(clientHello);
            }
          }
          break;
        case HandshakeType.client_key_exchange:
          {
            this.flight6 = new Flight6(this.transport, this.dtls, this.cipher);
            this.flight6.handleHandshake(handshake);
          }
          break;
        case HandshakeType.finished:
          {
            this.flight6.handleHandshake(handshake);
            await this.flight6.exec();

            this.onConnect.execute();
            log("dtls connected");
          }
          break;
      }
    }
  };
}
