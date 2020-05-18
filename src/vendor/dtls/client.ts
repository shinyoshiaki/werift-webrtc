import { Socket } from "dgram";
import { flight1 } from "./flight/client/flight1";
import { DtlsContext } from "./context/dtls";
import { UdpContext } from "./context/udp";
import { parsePacket } from "./record/receive";
import { ServerHelloVerifyRequest } from "./handshake/message/server/helloVerifyRequest";
import { flight3 } from "./flight/client/flight3";
import { ServerHello } from "./handshake/message/server/hello";
import { ServerHelloDone } from "./handshake/message/server/helloDone";
import { HandshakeType } from "./handshake/const";
import { Certificate } from "./handshake/message/certificate";
import { Flight5 } from "./flight/client/flight5";
import { FragmentedHandshake } from "./record/message/fragment";
import { ServerKeyExchange } from "./handshake/message/server/keyExchange";
import { RecordContext } from "./context/record";
import { createPlaintext } from "./record/builder";
import { ContentType } from "./record/const";
import { CipherContext } from "./context/cipher";
import { SessionType } from "./cipher/suites/abstract";

export type Options = { address: string; port: number; socket: Socket };

export class DtlsClient {
  onConnect?: () => void;
  onData: (buf: Buffer) => void = () => {};

  udp = new UdpContext(this.options.socket, this.options);
  dtls = new DtlsContext();
  record = new RecordContext();
  cipher = new CipherContext();
  constructor(private options: Options) {
    this.udp.socket.on("message", this.udpOnMessage);
    this.udpOnListening();
    this.cipher.sessionType = SessionType.CLIENT;
  }

  private udpOnListening = () => {
    flight1(this.udp, this.dtls, this.record, this.cipher);
  };

  private flight4Buffer: FragmentedHandshake[] = [];
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
          this.onData(messages[0].data as Buffer);
        }
        break;
    }
  };

  handleHandshakes(handshakes: FragmentedHandshake[]) {
    if (handshakes[0].msg_type === HandshakeType.server_hello) {
      this.flight4Buffer = handshakes;
    }
    if (this.flight4Buffer.length > 0) {
      this.flight4Buffer = [...this.flight4Buffer, ...handshakes];
    }

    switch (handshakes[handshakes.length - 1].msg_type) {
      case HandshakeType.hello_verify_request:
        {
          const verifyReq = ServerHelloVerifyRequest.deSerialize(
            handshakes[0].fragment
          );
          flight3(this.udp, this.dtls, this.record)(verifyReq);
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
          this.dtls.bufferHandshake(
            fragments.map((v) => v.serialize()),
            false,
            4
          );

          const messages = fragments.map((handshake) => {
            switch (handshake.msg_type) {
              case HandshakeType.server_hello:
                return ServerHello.deSerialize(handshake.fragment);
              case HandshakeType.certificate:
                return Certificate.deSerialize(handshake.fragment);
              case HandshakeType.server_key_exchange:
                return ServerKeyExchange.deSerialize(handshake.fragment);
              case HandshakeType.server_hello_done:
                return ServerHelloDone.deSerialize(handshake.fragment);
              default:
                return (undefined as any) as ServerHello;
            }
          });

          new Flight5(this.udp, this.dtls, this.record, this.cipher).exec(
            messages
          );
        }
        break;
      case HandshakeType.finished:
        {
          if (this.onConnect) this.onConnect();
        }
        break;
    }
  }

  send(buf: Buffer) {
    const pkt = createPlaintext(this.dtls)(
      [{ type: ContentType.applicationData, fragment: buf }],
      ++this.record.recordSequenceNumber
    )[0];
    this.udp.send(this.cipher.encryptPacket(pkt).serialize());
  }

  close() {
    this.udp.socket.close();
  }
}
