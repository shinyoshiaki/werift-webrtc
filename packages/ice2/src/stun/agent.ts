import * as nodeIp from "ip";
import { isIPv4 } from "net";
import Event from "rx.mini";
import { Address } from "../model";
import {
  Attributes,
  IPv4,
  xorIPv4Address,
  xorIPv6Address,
  XorMappedAddress,
  xorPort,
} from "./attributes";
import {
  Binding,
  randomTransactionId,
  Request,
  StunAttribute,
  StunClass,
  StunMessage,
  StunMessageHeader,
  StunMessageType,
  SuccessResponse,
} from "./message";
import { UdpTransport } from "../udp";

export class StunAgent {
  onResponse = new Event<[StunMessage]>();
  constructor(private stunServer: Address, readonly transport: UdpTransport) {}

  async setup() {
    this.transport.onData.subscribe((data, address) => {
      try {
        const message = StunMessage.Deserialize(data);
        console.log(message);
        switch (message.header.messageType.stunClass) {
          case SuccessResponse:
            {
              this.onResponse.execute(message);
            }
            break;
          case Request:
            {
              switch (message.header.messageType.stunMethod) {
                case Binding:
                  {
                    this.onBinding(message, address);
                  }
                  break;
              }
            }
            break;
        }
      } catch (error) {
        console.error(error);
      }
    });
  }

  private onBinding(message: StunMessage, sourceAddress: Address) {
    const messageIntegrity = message.attributes.find(
      (a) => a.type === Attributes.messageIntegrity
    );
    if (!messageIntegrity) {
      throw new Error();
    }

    const xorMappedAddress = new XorMappedAddress({
      family: isIPv4(sourceAddress[0]) ? 1 : 2,
    });
  }

  async binding(): Promise<Address> {
    const message = this.buildMessage({
      stunClass: Request,
      stunMethod: Binding,
      attributes: [],
    });
    const response = await this.request(message);
    const [attr] = response.attributes;
    const xorMappedAddress = XorMappedAddress.Deserialize(attr.value);
    const address =
      xorMappedAddress.family === IPv4
        ? xorIPv4Address(xorMappedAddress.xAddress)
        : xorIPv6Address(xorMappedAddress.xAddress);
    const port = xorPort(xorMappedAddress.xPort);

    return [nodeIp.toString(address), port];
  }

  buildMessage({
    stunClass,
    stunMethod,
    attributes,
  }: {
    stunMethod: number;
    stunClass: StunClass;
    attributes: StunAttribute[];
  }) {
    const messageLength = attributes.reduce((acc: number, cur) => {
      acc += cur.serialize().length;
      return acc;
    }, 0);
    const header = new StunMessageHeader({
      messageType: new StunMessageType({
        stunMethod,
        stunClass,
      }),
      messageLength,
      transactionId: randomTransactionId(),
    });
    const message = new StunMessage(header, attributes);
    return message;
  }

  request = async (message: StunMessage): Promise<StunMessage> => {
    let rto = 500;
    for (let i = 0; i < 7; i++) {
      const buf = message.serialize();
      this.transport.send(buf, this.stunServer).catch((e) => e);

      const res = await new Promise<StunMessage>((r, f) => {
        const { unSubscribe } = this.onResponse.subscribe((m) => {
          if (m.header.transactionId.equals(message.header.transactionId)) {
            r(m);
            unSubscribe();
          }
        });
        setTimeout(() => {
          rto *= 2;
          f(new Error("timeout"));
        }, rto);
      }).catch((e) => {
        console.warn(e);
      });
      if (res) {
        return res;
      }
    }
    throw new Error();
  };
}
