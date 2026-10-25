import { createSocket } from "node:dgram";

import { describe, expect, test } from "vitest";

import type { Address } from "../../common/src";
import {
  Message,
  NodeStunServer,
  StunServerProtocol,
  classes,
  methods,
  parseMessage,
} from "../src";

describe("StunServerProtocol", () => {
  test("responds to binding request with xor mapped address", () => {
    const protocol = new StunServerProtocol({
      software: "werift-ice-server/test",
      fingerprint: "always",
    });

    const remoteAddress: Address = ["203.0.113.10", 5000];
    const localAddress: Address = ["198.51.100.1", 3478];
    const request = new Message(methods.BINDING, classes.REQUEST);

    const [action] = protocol.handleDatagram({
      data: request.bytes,
      remoteAddress,
      localAddress,
      transport: "udp",
    });

    expect(action.type).toBe("send");
    if (action.type !== "send") {
      return;
    }

    const response = parseMessage(action.data);
    expect(response?.messageClass).toBe(classes.RESPONSE);
    expect(response?.messageMethod).toBe(methods.BINDING);
    expect(response?.getAttributeValue("XOR-MAPPED-ADDRESS")).toEqual(
      remoteAddress,
    );
    expect(response?.getAttributeValue("SOFTWARE")).toBe(
      "werift-ice-server/test",
    );
    expect(response?.getAttributeValue("FINGERPRINT")).toBeTypeOf("number");
  });

  test("ignores binding indication", () => {
    const protocol = new StunServerProtocol();
    const request = new Message(methods.BINDING, classes.INDICATION);

    expect(
      protocol.handleDatagram({
        data: request.bytes,
        remoteAddress: ["203.0.113.10", 5000],
        transport: "udp",
      }),
    ).toEqual([
      {
        type: "ignore",
        reason: "binding-indication",
      },
    ]);
  });

  test("returns 420 for unknown comprehension required attributes", () => {
    const protocol = new StunServerProtocol();
    const request = new Message(methods.BINDING, classes.REQUEST)
      .appendRawAttribute(0x4001, Buffer.alloc(0))
      .appendRawAttribute(0x1234, Buffer.alloc(0))
      .appendRawAttribute(0x4001, Buffer.alloc(0));

    const [action] = protocol.handleDatagram({
      data: request.bytes,
      remoteAddress: ["203.0.113.10", 5000],
      transport: "udp",
    });

    expect(action.type).toBe("send");
    if (action.type !== "send") {
      return;
    }

    const response = parseMessage(action.data);
    expect(response?.messageClass).toBe(classes.ERROR);
    expect(response?.getAttributeValue("ERROR-CODE")).toEqual([
      420,
      "Unknown Attribute",
    ]);
    expect(response?.getAttributeValue("UNKNOWN-ATTRIBUTES")).toEqual([
      0x1234, 0x4001,
    ]);
  });

  test("ignores malformed stun attributes", () => {
    const protocol = new StunServerProtocol();
    const request = new Message(
      methods.BINDING,
      classes.REQUEST,
    ).appendRawAttribute(0x0009, Buffer.alloc(2));

    expect(
      protocol.handleDatagram({
        data: request.bytes,
        remoteAddress: ["203.0.113.10", 5000],
        transport: "udp",
      }),
    ).toEqual([
      {
        type: "ignore",
        reason: "malformed",
      },
    ]);
  });
});

describe("NodeStunServer", () => {
  test("serves binding requests over udp", async () => {
    const server = new NodeStunServer({
      host: "127.0.0.1",
      port: 0,
      software: "werift-ice-server/test",
    });
    await server.listen();

    const client = createSocket("udp4");

    try {
      await new Promise<void>((resolve) => {
        client.bind({ address: "127.0.0.1", port: 0 }, resolve);
      });

      const request = new Message(methods.BINDING, classes.REQUEST);
      const responsePromise = new Promise<Buffer>((resolve) => {
        client.once("message", (data) => resolve(data));
      });

      const address = server.address!;
      client.send(request.bytes, address[1], address[0]);

      const responseData = await responsePromise;
      const response = parseMessage(responseData);
      const clientAddress = client.address();
      if (typeof clientAddress === "string") {
        throw new Error("Expected UDP client address info");
      }

      expect(response?.messageClass).toBe(classes.RESPONSE);
      expect(response?.getAttributeValue("XOR-MAPPED-ADDRESS")).toEqual([
        "127.0.0.1",
        clientAddress.port,
      ]);
      expect(response?.getAttributeValue("SOFTWARE")).toBe(
        "werift-ice-server/test",
      );
    } finally {
      client.close();
      await server.close();
    }
  });
});
