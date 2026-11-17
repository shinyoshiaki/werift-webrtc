/**
 * SDP パーサー / シリアライザーのテスト (sdp.test.ts, issue/355.test.ts) で共有する Arrange 用ユーティリティ。
 */

/**
 * audio m-section 1 つだけの最小 SDP を組み立てる。
 * `sessionHost` / `mediaHost` を省略すると、その階層の `c=` を出力しない。
 */
export function buildAudioSdp({
  sessionHost,
  mediaHost,
  mediaAttributes = [],
}: {
  sessionHost?: string;
  mediaHost?: string;
  /** `a=` 行 (先頭の `a=` を含む) */
  mediaAttributes?: string[];
}) {
  const lines = ["v=0", "o=- 1 1 IN IP4 0.0.0.0", "s=-"];
  if (sessionHost !== undefined) {
    lines.push(`c=${connectionLine(sessionHost)}`);
  }
  lines.push("t=0 0");
  lines.push("m=audio 49170 RTP/AVP 0");
  if (mediaHost !== undefined) {
    lines.push(`c=${connectionLine(mediaHost)}`);
  }
  lines.push("a=rtpmap:0 PCMU/8000");
  lines.push(...mediaAttributes);
  return lines.join("\r\n") + "\r\n";
}

function connectionLine(host: string) {
  return `IN ${host.includes(":") ? "IP6" : "IP4"} ${host}`;
}

/** SDP 文字列から `a=rtcp:` / `a=rtcp-mux` 行だけを取り出す */
export function rtcpLines(sdp: string) {
  return sdp
    .split("\r\n")
    .filter((line) => line.startsWith("a=rtcp:") || line === "a=rtcp-mux");
}

/**
 * #356 / #355: RingCentral (SIP over WebSocket) が送る audio offer をそのまま再現したもの。
 * `c=` は session-level だけで、`a=rtcp-mux` とアドレス省略形の `a=rtcp:48037` を併記する。
 */
export const ringCentralOffer = [
  "v=0",
  "o=- 1064673365023257083 6735761771923067257 IN IP4 208.87.41.111",
  "s=SmcSip",
  "c=IN IP4 208.87.41.111",
  "t=0 0",
  "a=ice-options:ice2 trickle renomination",
  "a=ice-pacing:50",
  "a=ice-ufrag:AKvO",
  "a=ice-pwd:C70ZBUSJgi2QfCglrI0RVl",
  "a=fingerprint:sha-256 89:03:03:DE:79:84:D7:6E:2B:D4:42:F6:4E:95:7F:72:29:7C:75:77:EA:9C:82:4D:FD:FC:74:BD:A7:F2:95:F4",
  "m=audio 48036 UDP/TLS/RTP/SAVPF 63 109 111 18 0 8 9 96 101",
  "a=sendrecv",
  "a=rtpmap:63 red/48000/2",
  "a=fmtp:63 111/111",
  "a=rtpmap:109 OPUS/16000",
  "a=fmtp:109 useinbandfec=1;usedtx=0",
  "a=rtpmap:111 OPUS/48000/2",
  "a=fmtp:111 useinbandfec=1;usedtx=0",
  "a=rtpmap:18 g729/8000",
  "a=fmtp:18 annexb=no",
  "a=rtpmap:0 pcmu/8000",
  "a=rtpmap:8 pcma/8000",
  "a=rtpmap:9 g722/8000",
  "a=rtpmap:96 ilbc/8000",
  "a=fmtp:96 mode=20",
  "a=rtpmap:101 telephone-event/8000",
  "a=fmtp:101 0-15",
  "a=rtcp-fb:109 ccm tmmbr",
  "a=rtcp-fb:111 ccm tmmbr",
  "a=mid:0",
  "a=setup:actpass",
  "a=candidate:371830e3 1 UDP 4294902018 208.87.41.111 48036 typ host",
  "a=candidate:371830e3 2 UDP 4294902531 208.87.41.111 48037 typ host",
  "a=end-of-candidates",
  "a=rtcp-mux",
  "a=rtcp:48037",
  "",
].join("\r\n");
