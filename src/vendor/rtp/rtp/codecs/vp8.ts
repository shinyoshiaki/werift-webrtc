/*
 * https://tools.ietf.org/html/rfc7741#section-4.2
 *
 *       0 1 2 3 4 5 6 7
 *      +-+-+-+-+-+-+-+-+
 *      |X|R|N|S|R| PID | (REQUIRED)
 *      +-+-+-+-+-+-+-+-+
 * X:   |I|L|T|K| RSV   | (OPTIONAL)
 *      +-+-+-+-+-+-+-+-+
 * I:   |M| PictureID   | (OPTIONAL)
 *      +-+-+-+-+-+-+-+-+
 * L:   |   TL0PICIDX   | (OPTIONAL)
 *      +-+-+-+-+-+-+-+-+
 * T/K: |TID|Y| KEYIDX  | (OPTIONAL)
 *      +-+-+-+-+-+-+-+-+
 *  S: Start of VP8 partition.  SHOULD be set to 1 when the first payload
 *     octet of the RTP packet is the beginning of a new VP8 partition,
 *     and MUST NOT be 1 otherwise.  The S bit MUST be set to 1 for the
 *     first packet of each encoded frame.
 */

const vp8HeaderSize = 1;

export class VP8 {
  x: number;
  n: number;
  s: number;
  pid: number;
  i: number;
  l: number;
  t: number;
  k: number;
  pictureId: number;
  tloPicIdx: number;
  payload: Buffer;

  static payLoader(mtu: number, payload: Buffer) {
    const maxFragmentSize = mtu - vp8HeaderSize;

    let payloadDataRemaining = payload.length;
    let payloadDataIndex = 0;

    if (Math.min(maxFragmentSize, payloadDataRemaining) <= 0) return [];

    const payloads: Buffer[] = [];
    while (payloadDataRemaining > 0) {
      const currentFragmentSize = Math.min(
        maxFragmentSize,
        payloadDataRemaining
      );
      const out: { [key: number]: number } = {};
      if (payloadDataRemaining === payload.length) {
        out[0] = 0x00;
      }
      payload
        .slice(payloadDataIndex, payloadDataIndex + currentFragmentSize)
        .forEach((v, i) => {
          out[vp8HeaderSize + i] = v;
        });
      payloads.push(
        Buffer.from(
          Object.keys(out)
            .sort()
            .map((i) => out[Number(i)])
        )
      );

      payloadDataRemaining -= currentFragmentSize;
      payloadDataIndex += currentFragmentSize;
    }

    return payloads;
  }

  static deSerialize(payload: Buffer) {
    const p = new VP8();
    let payloadIndex = 0;
    p.x = (payload[payloadIndex] & 0x80) >> 7;
    p.n = (payload[payloadIndex] & 0x20) >> 5;
    p.s = (payload[payloadIndex] & 0x10) >> 4;
    p.pid = payload[payloadIndex] & 0x07;

    payloadIndex++;

    if (p.x === 1) {
      p.i = (payload[payloadIndex] & 0x80) >> 7;
      p.l = (payload[payloadIndex] & 0x40) >> 6;
      p.t = (payload[payloadIndex] & 0x20) >> 5;
      p.k = (payload[payloadIndex] & 0x10) >> 4;
      payloadIndex++;
    }

    if (p.i == 1) {
      // PID present?
      if ((payload[payloadIndex] & 0x80) > 0) {
        // M == 1, PID is 16bit
        payloadIndex += 2;
      } else {
        payloadIndex++;
      }
    }

    if (p.l == 1) {
      payloadIndex++;
    }

    if (p.t == 1 || p.k == 1) {
      payloadIndex++;
    }

    if (payloadIndex >= payload.length) {
      throw new Error("Payload is not large enough");
    }

    p.payload = payload.slice(payloadIndex);
    return p;
  }

  static isPartitionHead(packet: Buffer) {
    const p = VP8.deSerialize(packet);
    return p.s === 1;
  }
}
