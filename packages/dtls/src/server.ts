import debug from "debug";

import { SessionType } from "./cipher/suites/abstract";
import { flight2 } from "./flight/server/flight2";
import { Flight4 } from "./flight/server/flight4";
import { Flight6 } from "./flight/server/flight6";
import { HandshakeType } from "./handshake/const";
import { ClientHello } from "./handshake/message/client/hello";
import { FragmentedHandshake } from "./record/message/fragment";
import { DtlsSocket, Options } from "./socket";

const log = debug("werift-dtls : packages/dtls/src/server.ts : log");

export class DtlsServer extends DtlsSocket {
  constructor(options: Options) {
    super(options, SessionType.SERVER);
    this.onHandleHandshakes = this.handleHandshakes;
    log(this.dtls.session, "start server");
  }

  private flight6!: Flight6;
  private handleHandshakes = async (assembled: FragmentedHandshake[]) => {
    log(
      this.dtls.session,
      "handleHandshakes",
      assembled.map((a) => a.msg_type)
    );

    for (const handshake of assembled) {
      switch (handshake.msg_type) {
        case HandshakeType.client_hello_1:
          {
            const clientHello = ClientHello.deSerialize(handshake.fragment);

            if (
              this.dtls.cookie &&
              clientHello.cookie.equals(this.dtls.cookie)
            ) {
              log(this.dtls.session, "send flight4");
              await new Flight4(
                this.transport,
                this.dtls,
                this.cipher,
                this.srtp
              ).exec(handshake, this.options.certificateRequest);
            } else if (!this.dtls.session) {
              log(this.dtls.session, "send flight2");
              flight2(
                this.transport,
                this.dtls,
                this.cipher,
                this.srtp
              )(clientHello);
            }
          }
          break;
        case HandshakeType.client_key_exchange_16:
          {
            this.flight6 = new Flight6(this.transport, this.dtls, this.cipher);
            this.flight6.handleHandshake(handshake);
          }
          break;
        case HandshakeType.finished_20:
          {
            this.flight6.handleHandshake(handshake);
            await this.flight6.exec();

            this.onConnect.execute();
            log(this.dtls.session, "dtls connected");
          }
          break;
      }
    }
  };
}
