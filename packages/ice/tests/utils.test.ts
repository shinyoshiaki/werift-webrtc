import { createSocket } from "dgram";

import { findPort } from "../../common/src";
import { randomString } from "../src/helper";
import { selectAddressesFromInterfaces } from "../src/internal/selectAddresses";
import { getGlobalIp, isLinkLocalAddress } from "../src/utils";

describe("utils", () => {
  test("randomString", () => {
    expect(randomString(23).length).toBe(23);
  });

  test("findPort", async () => {
    const port = await findPort(1234, 10000, "udp4");
    const socket = createSocket("udp4");
    socket.bind(port);

    await new Promise<void>((r) => {
      socket.once("listening", r);
    });
    socket.close();
  }, 60_000);

  test("getGlobalIp", async () => {
    const gip = await getGlobalIp();
    expect(gip).toBeTruthy();
  });

  test("selectAddressesFromInterfaces excludes internal and link-local by default", () => {
    // Arrange: internal / link-local / 通常アドレスを混ぜた interface
    const interfaces = {
      lo: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4" as const,
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      eth0: [
        {
          address: "192.0.2.10",
          netmask: "255.255.255.0",
          family: "IPv4" as const,
          mac: "00:11:22:33:44:55",
          internal: false,
          cidr: "192.0.2.10/24",
        },
        {
          address: "169.254.1.2",
          netmask: "255.255.0.0",
          family: "IPv4" as const,
          mac: "00:11:22:33:44:55",
          internal: false,
          cidr: "169.254.1.2/16",
        },
      ],
    };

    // Act: 非公開 helper に interface 辞書を注入して選別する
    const addresses = selectAddressesFromInterfaces(
      interfaces,
      4,
      {},
      isLinkLocalAddress,
    );

    // Assert: internal と link-local が除外されること
    expect(addresses).toEqual(["192.0.2.10"]);
  });

  test("selectAddressesFromInterfaces keeps link-local when enabled", () => {
    // Arrange
    const interfaces = {
      eth0: [
        {
          address: "169.254.1.2",
          netmask: "255.255.0.0",
          family: "IPv4" as const,
          mac: "00:11:22:33:44:55",
          internal: false,
          cidr: "169.254.1.2/16",
        },
      ],
    };

    // Act
    const addresses = selectAddressesFromInterfaces(
      interfaces,
      4,
      { useLinkLocalAddress: true },
      isLinkLocalAddress,
    );

    // Assert: link-local が残ること
    expect(addresses).toEqual(["169.254.1.2"]);
    expect(
      isLinkLocalAddress({
        address: "169.254.1.2",
        netmask: "255.255.0.0",
        family: "IPv4",
        mac: "00:11:22:33:44:55",
        internal: false,
        cidr: "169.254.1.2/16",
      }),
    ).toBe(true);
  });
});
