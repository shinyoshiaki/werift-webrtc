import { createSocket } from "dgram";

import { findPort } from "../../common/src";
import { randomString } from "../src/helper";
import {
  selectAddressesFromInterfaces,
  selectHostInterfaces,
} from "../src/internal/selectAddresses";
import { getGlobalIp, isLinkLocalAddress } from "../src/utils";
import { createLocalStunServer, fakeNetworkInterfaces } from "./utils";

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
    // Arrange: 外部ネットワークに依存しないローカル STUN サーバーを用意する。
    const server = await createLocalStunServer("127.0.0.1");
    try {
      // Act: ローカル STUN サーバーから観測したアドレスを取得する。
      const gip = await getGlobalIp(server.address!);

      // Assert: STUN 応答に含まれる送信元アドレスが返る。
      expect(gip).toBe("127.0.0.1");
    } finally {
      await server.close();
    }
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

  test("selectHostInterfaces binds a link-local IPv6 address with its zone", () => {
    // Arrange: link-local と global の IPv6 を持つ NIC
    const interfaces = fakeNetworkInterfaces({
      eth1: ["2001:db8::1"],
      eth0: ["fe80::1"],
    });

    // Act: link-local を含めて選別する
    const hosts = selectHostInterfaces(
      interfaces,
      6,
      { useLinkLocalAddress: true },
      isLinkLocalAddress,
    );

    // Assert: NIC 名順で、link-local だけ zone 付きの bind アドレスになる
    expect(hosts).toEqual([
      {
        address: "fe80::1",
        nic: "eth0",
        bindAddress: "fe80::1%eth0",
        costly: false,
      },
      {
        address: "2001:db8::1",
        nic: "eth1",
        bindAddress: "2001:db8::1",
        costly: false,
      },
    ]);
  });

  test("selectHostInterfaces keeps costly networks after the others and bans vmnet / veth", () => {
    // Arrange: VPN (tun / utun / ipsec / tap)、仮想 NIC (vmnet / veth)、通常 NIC を混ぜる
    const interfaces = fakeNetworkInterfaces({
      tun0: ["10.8.0.2"],
      eth0: ["192.0.2.10"],
      utun3: ["10.9.0.2"],
      vmnet1: ["172.16.1.1"],
      veth12: ["172.17.0.5"],
      ipsec0: ["10.10.0.2"],
      tap0: ["10.11.0.2"],
    });

    // Act: gather 用と公開 API 用にそれぞれ選別する
    const hosts = selectHostInterfaces(interfaces, 4, {}, isLinkLocalAddress);
    const publicAddresses = selectAddressesFromInterfaces(
      interfaces,
      4,
      {},
      isLinkLocalAddress,
    );

    // Assert: gather 用は costly な NIC を通常 NIC の後に含め、vmnet / veth は除外する
    expect(hosts.map(({ nic, costly }) => [nic, costly])).toEqual([
      ["eth0", false],
      ["ipsec0", true],
      ["tap0", true],
      ["tun0", true],
      ["utun3", true],
    ]);
    // Assert: 公開 API (getHostAddresses など) の戻り値は従来どおり costly を含めない
    expect(publicAddresses).toEqual(["192.0.2.10"]);
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
