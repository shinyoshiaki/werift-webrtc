import { Flight1 } from "./flight/client/flight1";
import { parsePacket } from "./record/receive";
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
  private flight4Buffer: FragmentedHandshake[] = [];
  constructor(options: Options) {
    super(options, SessionType.CLIENT);
    this.udp.socket.onData = this.udpOnMessage;
    log("start client");
  }

  connect() {
    new Flight1(this.udp, this.dtls, this.cipher).exec(this.extensions);
  }

  private udpOnMessage = (data: Buffer) => {
    const messages = parsePacket(this.dtls, this.cipher)(data);
    if (messages.length === 0) {
      // this is not dtls message
      return;
    }

    switch (messages[messages.length - 1].type) {
      case ContentType.handshake:
        {
          this.handleHandshakes(
            messages.map((v) => v.data as FragmentedHandshake).filter((v) => v)
          );
        }
        break;
      case ContentType.applicationData:
        {
          this.onData.execute(messages[0].data as Buffer);
        }
        break;
      case ContentType.alert:
        this.onClose.execute();
        break;
    }
  };

  private handleHandshakes(handshakes: FragmentedHandshake[]) {
    if (this.flight4Buffer.length > 0) {
      this.flight4Buffer = [...this.flight4Buffer, ...handshakes];
    } else if (handshakes[0].msg_type === HandshakeType.server_hello) {
      this.flight4Buffer = handshakes;
    }

    switch (handshakes.slice(-1)[0].msg_type) {
      case HandshakeType.hello_verify_request:
        {
          const verifyReq = ServerHelloVerifyRequest.deSerialize(
            handshakes[0].fragment
          );
          new Flight3(this.udp, this.dtls).exec(verifyReq);
        }
        break;
      case HandshakeType.server_hello_done:
        {
          const fragments = [
            HandshakeType.server_hello,
            HandshakeType.certificate,
            HandshakeType.server_key_exchange,
            HandshakeType.certificate_request,
            HandshakeType.server_hello_done,
          ]
            .map((type) => {
              const fragments = FragmentedHandshake.findAllFragments(
                this.flight4Buffer,
                type
              );
              if (fragments.length === 0)
                return (undefined as any) as FragmentedHandshake;
              return FragmentedHandshake.assemble(fragments);
            })
            .filter((v) => v);
          this.flight4Buffer = [];

          new Flight5(this.udp, this.dtls, this.cipher, this.srtp).exec(
            fragments
          );
        }
        break;
      case HandshakeType.finished:
        {
          this.dtls.flight = 7;
          this.onConnect.execute();
        }
        break;
    }
  }
}
