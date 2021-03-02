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
import debug from "debug";

const log = debug("werift/dtls/server");

export class DtlsServer extends DtlsSocket {
  bufferHandshakes: FragmentedHandshake[] = [];

  constructor(options: Options) {
    super(options, SessionType.SERVER);
    this.udp.socket.onData = this.udpOnMessage;
    log("start server", options);
  }

  handleFragmentHandshake(messages: FragmentedHandshake[]) {
    let handshakes = messages
      .filter((v) => {
        if (v.fragment_length !== v.length) {
          this.bufferHandshakes.push(v);
          return false;
        }
        return true;
      })
      .filter((v) => v);
    if (this.bufferHandshakes.length > 1) {
      const last = this.bufferHandshakes.slice(-1)[0];
      if (last.fragment_offset + last.fragment_length === last.length) {
        handshakes = [...this.bufferHandshakes, ...handshakes];
        this.bufferHandshakes = [];
      }
    }
    if (handshakes.length > 0) return handshakes;
    return;
  }

  private udpOnMessage = async (data: Buffer) => {
    const messages = parsePacket(this.dtls, this.cipher)(data);
    switch (messages[0].type) {
      case ContentType.handshake:
        {
          const handshakes = this.handleFragmentHandshake(
            messages.map((v) => v.data as FragmentedHandshake).filter((v) => v)
          );
          if (handshakes) {
            await this.handleHandshakes(handshakes);
          }
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

  private flight6?: Flight6;
  private async handleHandshakes(handshakes: FragmentedHandshake[]) {
    const encryptedHandshake = handshakes.find((v) => v.msg_type == undefined);

    const assembled = Object.values(
      handshakes
        .filter((v) => v.msg_type != undefined)
        .reduce((acc: { [type: string]: FragmentedHandshake[] }, cur) => {
          if (!acc[cur.msg_type]) acc[cur.msg_type] = [];
          acc[cur.msg_type].push(cur);
          return acc;
        }, {})
    )
      .map((v) => FragmentedHandshake.assemble(v))
      .sort((a, b) => a.msg_type - b.msg_type);

    log("handleHandshakes", assembled, encryptedHandshake);

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
            this.flight6.handleClientKeyExchange(handshake);
          }
          break;
        case HandshakeType.finished:
          {
            log("send flight6");
            this.flight6?.exec(handshake);
            this.onConnect.execute();
          }
          break;
      }
    }

    if (encryptedHandshake) {
      log("encrypted handshake received");
      this.flight6?.exec(encryptedHandshake);
      this.onConnect.execute();
    }
  }
}
