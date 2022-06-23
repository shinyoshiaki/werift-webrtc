// rfc5109

import { BitStream, bufferReader } from "../../../../common/src";
import { RtpHeader, RtpPacket } from "../rtp";

// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                RTP Header (12 octets or more)                 |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                    FEC Header (10 octets)                     |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                      FEC Level 0 Header                       |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                     FEC Level 0 Payload                       |
// |                                                               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                      FEC Level 1 Header                       |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                     FEC Level 1 Payload                       |
// |                                                               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                            Cont.                              |
// |                                                               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

export class UlpFec {
  fecHeader: UlpFecHeader;
  level: FecLevel[] = [];

  static deSerialize(buf: Buffer) {
    let offset = 0;
    const fec = new UlpFec();

    fec.fecHeader = UlpFecHeader.deSerialize(buf.slice(offset));
    offset += 10;

    for (;;) {
      const level = FecLevel.deSerialize(buf.slice(offset), fec.fecHeader.lBit);
      fec.level.push(level);
      offset += level.offset;

      if (offset >= buf.length) {
        break;
      }
    }
    return fec;
  }
}

//     0                   1                   2                   3
//     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//    |E|L|P|X|  CC   |M| PT recovery |            SN base            |
//    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//    |                          TS recovery                          |
//    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//    |        length recovery        |
//    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

export class UlpFecHeader {
  /**この仕様に対する将来の拡張を示すために予約されている拡張フラグです. これは0に設定する必要があり、受信者は無視する必要があります.  */
  eBit: number;
  /**ロングマスクが使用されているかどうかを示します. Lビットが設定されていない場合、マスクは16ビット長になります. Lビットが設定されると、マスクの長さは48ビットになります.  */
  lBit: number;
  /**FECパケットに関連付けられたメディアパケットのRTPヘッダーから対応するP、X、CC、M、PT値に適用される保護演算を介して取得されます。 */
  pBit: number;
  /**FECパケットに関連付けられたメディアパケットのRTPヘッダーから対応するP、X、CC、M、PT値に適用される保護演算を介して取得されます。 */
  xBit: number;
  /**FECパケットに関連付けられたメディアパケットのRTPヘッダーから対応するP、X、CC、M、PT値に適用される保護演算を介して取得されます。 */
  cc: number;
  /**FECパケットに関連付けられたメディアパケットのRTPヘッダーから対応するP、X、CC、M、PT値に適用される保護演算を介して取得されます。 */
  mBit: number;
  /**FECパケットに関連付けられたメディアパケットのRTPヘッダーから対応するP、X、CC、M、PT値に適用される保護演算を介して取得されます。 */
  pt: number;
  /**すべてのレベルで）FECによって保護されているメディアパケットの中で、ラップアラウンドを考慮して、最小のシーケンス番号に設定する必要があります. これにより、FEC操作は、Lフィールドが0に設定されている場合は最大16パケット、Lフィールドが1に設定されている場合は48パケットの任意の文字列に拡張できます.  */
  sn: number;
  /**このFECパケットに関連付けられたメディアパケットのタイムスタンプに適用される保護操作を介して計算されます. これにより、タイムスタンプを完全に回復できます.  */
  ts: number;
  /**回復されたパケットの長さを決定するために使用されます. これは、メディアペイロードの長さ（バイト単位）、CSRCリスト、このFECパケットに関連付けられた各メディアパケットの拡張とパディングの合計の符号なしネットワーク順序16ビット表現に適用される保護操作を介して計算されます.  （言い換えると、CSRCリスト、RTP拡張、およびメディアペイロードパケットのパディング（存在する場合）は、ペイロードの一部として「カウント」されます）. これにより、保護されたメディアパケットの長さが同じでない場合でも、FEC手順を適用できます. たとえば、FECパケットが2つのメディアパケットを一緒に排他的論理和することによって生成されていると仮定します. 2つのメディアパケットのペイロードの長さは、それぞれ3（0b011）バイトと5（0b101）バイトです. */
  length: number;

  static deSerialize(buf: Buffer) {
    const header = new UlpFecHeader();
    let offset = 0;

    const bitStream = new BitStream(buf.slice(offset));
    header.eBit = bitStream.readBits(1);
    if (header.eBit === 1) {
      //   throw new Error("invalid");
    }
    header.lBit = bitStream.readBits(1);
    header.pBit = bitStream.readBits(1);
    header.xBit = bitStream.readBits(1);
    header.cc = bitStream.readBits(4);
    header.mBit = bitStream.readBits(1);
    header.pt = bitStream.readBits(7);
    offset += 2;

    [header.sn, header.ts, header.length] = bufferReader(
      buf.slice(offset),
      [2, 4, 2]
    );

    return header;
  }
}

export class FecLevel {
  protectionLength: number;
  mask: number;
  payload: Buffer;
  offset: number;

  static deSerialize(buf: Buffer, lBit: number) {
    let offset = 0;
    const level = new FecLevel();
    level.protectionLength = buf.readUint16BE();
    offset += 2;

    if (lBit === 0) {
      level.mask = buf.slice(offset).readUint16BE();
      offset += 2;
    } else {
      level.mask = buf.slice(offset).readUintBE(0, 6);
      offset += 6;
    }

    level.payload = buf.slice(offset, offset + level.protectionLength);
    offset += level.protectionLength;

    level.offset = offset;

    return level;
  }
}
