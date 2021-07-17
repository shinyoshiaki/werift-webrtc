import { createSocket } from "dgram";
import { range } from "lodash";
import { setTimeout } from "timers/promises";
import { SCTP, SCTP_STATE, WEBRTC_PPID } from "../src";
import { createUdpTransport } from "../src/transport";


(async () => {
  const transport = createUdpTransport(createSocket("udp4"), {
    port: 5678,
    address: "127.0.0.1",
  });

  const sctp = SCTP.client(transport);
  sctp.onReceive.subscribe((...args) => {
    console.log(args[2].toString());
    console.log(args);
  });
  await sctp.start(5000);
  await waitForOutcome(sctp);
  let sec = 0;
  setInterval(
    () => sctp.send(0, WEBRTC_PPID.STRING, Buffer.from("ping " + sec++)),
    1000
  );
})();

async function waitForOutcome(sctp: SCTP) {
  const final = [SCTP_STATE.ESTABLISHED];
  for (const _ of range(100)) {
    if (final.includes(sctp.associationState)) {
      break;
    }

    await setTimeout(100);
  }
}
