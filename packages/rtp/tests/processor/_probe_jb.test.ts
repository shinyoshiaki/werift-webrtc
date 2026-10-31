import { RtpHeader, RtpPacket } from "../../src";
import { JitterBufferBase } from "../../src/extra/processor/jitterBuffer";
const pk = (s: number, t: number) =>
  new RtpPacket(new RtpHeader({ sequenceNumber: s & 0xffff, timestamp: t >>> 0 }), Buffer.from([s & 0xff]));
function run(order: number[], base = 0, tsBase = 0) {
  const jb = new JitterBufferBase(48000, { latency: 200 });
  const out: number[] = []; const lost: any[] = [];
  const feed = (o: any[]) => { for (const x of o) { if (x.rtp) out.push(x.rtp.header.sequenceNumber); if (x.isPacketLost) lost.push(x.isPacketLost); } };
  for (const i of order) feed(jb.processInput({ rtp: pk(base + i, tsBase + i * 960) }));
  feed(jb.processInput({ eol: true }));
  return { out, lost };
}
const seq = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
it.each([
  ["review8: 1 lost, 13/12 swapped", [0, ...seq(2, 11), 13, 12, 14, 15, ...seq(16, 30)]],
  ["two independent losses (1, 12)", [0, ...seq(2, 11), ...seq(13, 30)]],
  ["burst loss 1..3", [0, ...seq(4, 30)]],
  ["loss then late arrival after timeout", [0, ...seq(2, 14), 1, ...seq(15, 30)]],
  ["swap right after timeout point", [0, ...seq(2, 12), 14, 13, ...seq(15, 30)]],
])("%s", (_name, order) => {
  const r = run(order as number[]);
  console.log(_name, JSON.stringify(r.out), JSON.stringify(r.lost));
});
it("wraparound", () => {
  const order = [0, ...seq(2, 11), 13, 12, ...seq(14, 30)];
  const r = run(order, 65530, 0xffffffff - 5 * 960);
  console.log("wrap", JSON.stringify(r.out), JSON.stringify(r.lost));
});
