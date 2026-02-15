import { setTimeout as delay } from "timers/promises";

import { SCTP, SCTP_STATE, WEBRTC_PPID, type Transport } from "../src";

const activeTimerHandles = () =>
  ((process as any)._getActiveHandles?.() ?? []).filter((handle: any) => {
    const name = handle?.constructor?.name;
    return name === "Timeout" || name === "Immediate";
  }).length;

const main = async () => {
  const transport: Transport = {
    async send() {},
    close() {},
  };
  const sctp = SCTP.client(transport);
  sctp.setRemotePort(5000);
  sctp.setState(SCTP_STATE.ESTABLISHED);

  const baseline = activeTimerHandles();
  for (let i = 0; i < 200; i++) {
    void sctp.send(0, WEBRTC_PPID.STRING, Buffer.from("ping")).catch(() => {});
  }

  await delay(20);
  await sctp.stop();
  sctp.transport.close();
  await delay(20);

  if (sctp.transport.onData !== undefined) {
    throw new Error("transport.onData must be undefined after stop");
  }

  const after = activeTimerHandles();
  if (after > baseline) {
    throw new Error(`timer handle leak detected: baseline=${baseline}, after=${after}`);
  }
};

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
