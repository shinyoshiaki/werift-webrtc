import debug from "debug";
import { setTimeout } from "timers/promises";

import { SessionType } from "./cipher/suites/abstract";
import { Flight1 } from "./flight/client/flight1";
import { Flight3 } from "./flight/client/flight3";
import { Flight5 } from "./flight/client/flight5";
import { HandshakeType } from "./handshake/const";
import { ServerHelloVerifyRequest } from "./handshake/message/server/helloVerifyRequest";
import { FragmentedHandshake } from "./record/message/fragment";
import { DtlsSocket, Options } from "./socket";

const log = debug("werift-dtls : packages/dtls/src/client.ts : log");

export class DtlsClient extends DtlsSocket {
  constructor(options: Options) {
    super(options, SessionType.CLIENT);
    this.onHandleHandshakes = this.handleHandshakes;
    log(this.dtls.session, "start client");
  }

  async connect() {
    await new Flight1(this.transport, this.dtls, this.cipher).exec(
      this.extensions
    );
  }

  private flight5!: Flight5;
  private handleHandshakes = async (assembled: FragmentedHandshake[]) => {
    log(
      this.dtls.session,
      "handleHandshakes",
      assembled.map((a) => a.msg_type)
    );

    for (const handshake of assembled) {
      switch (handshake.msg_type) {
        case HandshakeType.hello_verify_request_3:
          {
            const verifyReq = ServerHelloVerifyRequest.deSerialize(
              handshake.fragment
            );
            await new Flight3(this.transport, this.dtls).exec(verifyReq);
          }
          break;
        case HandshakeType.server_hello_2:
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
        case HandshakeType.certificate_11:
        case HandshakeType.server_key_exchange_12:
        case HandshakeType.certificate_request_13:
          {
            this.flight5.handleHandshake(handshake);
          }
          break;
        case HandshakeType.server_hello_done_14:
          {
            this.flight5.handleHandshake(handshake);
            for (let i = 0; i < 10; i++) {
              if (
                ![11, 12].find(
                  (type) =>
                    this.dtls.sortedHandshakeCache.find(
                      (h) => h.data.msg_type === type
                    ) == undefined
                )
              ) {
                log(this.dtls.session, "ready flight5", i);
                await this.flight5.exec();
                break;
              } else {
                log(
                  this.dtls.session,
                  "not arrived",
                  this.dtls.sortedHandshakeCache.map((h) => h.data.summary)
                );
                await setTimeout(100 * i);
              }
            }
          }
          break;
        case HandshakeType.finished_20:
          {
            this.dtls.flight = 7;
            this.onConnect.execute();
            log(this.dtls.session, "dtls connected");
          }
          break;
      }
    }
  };
}
