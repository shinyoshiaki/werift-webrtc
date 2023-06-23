import { LipsyncBase, LipsyncOutput } from "../../src";

describe("Lipsync", () => {
  it("Properly executedTasked multiple times when a packet is passed over a period of time longer than the interval", async () => {
    const audioOutputs: LipsyncOutput[] = [];

    const lipsync = new LipsyncBase(
      (o) => {
        audioOutputs.push(o);
      },
      () => {},
      {
        syncInterval: 1000,
        bufferLength: 10,
        fillDummyAudioPacket: Buffer.alloc(1),
      }
    );

    lipsync.processAudioInput({
      frame: { time: 0, isKeyframe: true, data: Buffer.alloc(0) },
    });
    expect(audioOutputs.length).toBe(0);

    lipsync.processAudioInput({
      frame: { time: 2000, isKeyframe: true, data: Buffer.alloc(0) },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(audioOutputs.length).toBe(2000 / 20);

    lipsync.processAudioInput({
      frame: { time: 2020, isKeyframe: true, data: Buffer.alloc(0) },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(audioOutputs.length).toBe(2000 / 20);

    lipsync.processAudioInput({
      frame: { time: 3000, isKeyframe: true, data: Buffer.alloc(0) },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(audioOutputs.length).toBe(3000 / 20);
  });
});
