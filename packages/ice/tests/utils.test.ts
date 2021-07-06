import { createSocket } from "dgram";
import exp from "node:constants";

import { randomString } from "../src/helper";
import { findPort, getGlobalIp } from "../src/utils";

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
});
