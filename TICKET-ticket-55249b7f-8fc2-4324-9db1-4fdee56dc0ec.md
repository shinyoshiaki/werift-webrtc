## Summary

`RTCIceCandidate` currently exposes only:

- `candidate`
- `sdpMid`
- `sdpMLineIndex`
- `usernameFragment`

even though werift already parses and stores the full ICE candidate internally (`foundation`, component, protocol, priority, address/IP, port, candidate type, related address/port, TCP type, etc.).

As a result, consumers that need to inspect the selected candidate pair have to parse the SDP candidate string themselves.

A real-world example is OpenHarness, which uses werift for a WebRTC DataChannel transport. To determine whether the nominated pair is relayed, it currently regex-parses the local and remote candidate strings for `typ relay`:

https://github.com/autonomous-ai/openharness/blob/6aef03d565b740ab02fd4eb866bd0f3232d54991/cli/src/lib/terminalP2p.ts

This should be available directly as `candidate.type === "relay"`, matching browser `RTCIceCandidate` behavior.

## Current implementation

In `packages/webrtc/src/transport/ice.ts`, the internal `IceCandidate` already has the needed parsed fields:

```ts
export class IceCandidate {
  constructor(
    public component: number,
    public foundation: string,
    public ip: string,
    public port: number,
    public priority: number,
    public protocol: string,
    public type: string,
    ...
  ) {}
}
```

But `IceCandidate.toJSON()` converts it to `RTCIceCandidate` while keeping only the SDP string and signaling metadata:

```ts
toJSON(): RTCIceCandidate {
  return new RTCIceCandidate({
    candidate: candidateToSdp(this),
    sdpMLineIndex: this.sdpMLineIndex,
    sdpMid: this.sdpMid,
    usernameFragment: this.ufrag,
  });
}
```

And `RTCIceCandidate` itself only declares those four fields.

This also affects werift's `RTCIceTransport.getSelectedCandidatePair()`, `getLocalCandidates()`, and `getRemoteCandidates()`, because they all return the reduced `RTCIceCandidate` representation.

## Expected behavior

Match the WebRTC `RTCIceCandidate` shape more closely by exposing parsed readonly properties derived from the candidate a-line:

- `foundation`
- `component` (`"rtp"` / `"rtcp"`)
- `priority`
- `address`
- `protocol` (`"udp"` / `"tcp"`)
- `port`
- `type` (`"host"` / `"srflx"` / `"prflx"` / `"relay"`)
- `tcpType`
- `relatedAddress`
- `relatedPort`

The current WebRTC spec also defines `relayProtocol` and `url` for local srflx/relay candidates. Those require retaining the originating ICE-server metadata, so they may be implemented in the same change or separately if that keeps the patch smaller.

Spec:
https://w3c.github.io/webrtc-pc/#rtcicecandidate-interface

## Suggested implementation

1. Extend `RTCIceCandidate` with the browser-compatible parsed fields.
2. Populate them in `IceCandidate.toJSON()` without reparsing the SDP string.
3. Update `RTCIceCandidate.fromSdp()` / constructor behavior so a candidate created from an a-line exposes the same fields.
4. Preserve the current `toJSON()` signaling shape unless changing it is intentional; browser `toJSON()` should remain suitable for signaling.
5. Add tests for:
   - host / srflx / relay candidate properties;
   - TCP `tcpType`;
   - related address/port;
   - `RTCIceTransport.getSelectedCandidatePair()` returning candidates whose `type` is directly inspectable;
   - construction via `RTCIceCandidate.fromSdp()`.

## Why this matters

This is more than convenience for OpenHarness. werift now provides browser-shaped globals/polyfills, and the standard `RTCIceCandidate` API exposes these parsed properties. Keeping the data only inside the ICE-layer candidate while dropping it at the public WebRTC-layer object forces every consumer to duplicate candidate parsing and makes code written against browser WebRTC less portable.

OpenHarness is a concrete downstream example where this missing API has already produced such a workaround.

## 追加要件: 検証基準と経路の一本化 (レビュー 7 回非承認の打開策)

指摘された入力を個別に塞ぐのではなく、判定基準を契約として先に定め、すべての経路を 1 つのモジュールに通す。

### A. 検証と変換の単一モジュール (`packages/webrtc/src/transport/iceCandidateAttribute.ts`)
- 入口は `parseCandidateAttribute(raw)` のみ。`candidate:` 接頭辞の除去は 1 回だけ行い、`" "` で分割して ABNF の要素ごとに検証する。
- 型付きの値は `isValidCandidateValues()` で、同じ要素検証器を使って検証する。`IceCandidate.toJSON()` は文字列を再生成・再解析せず、これで検証する。
- W3C 属性への対応付けは `candidateFieldsFromValues()` に分ける。
- コンストラクター、`fromSdp`、`fromJSON` の 3 経路とも、これらの関数だけを使う。`fromSdp(sdp)` は `new RTCIceCandidate({ candidate: sdp })` と同じ解析を行い、さらに従来どおり `ufrag` 拡張属性を `usernameFragment` に設定する(有効な候補のときだけ。属性と `toJSON()` の両方をテストで確認する)。

### B. コンストラクターは `RTCIceCandidateInit` だけを読む
- `init` に含まれる派生属性は無視し、常に `candidate` から解析する(省略時は `""`)。
- 内部から解析済みの値を渡す経路は、export しない `Symbol` を使うモジュール内のファクトリーに分ける。

### C. `IceCandidate.fromJSON` の厳格化(拒否を採用)
- 文法違反の候補は `undefined` を返す。そのため `addIceCandidate` は `OperationError` で拒否する(ブラウザーと同じ)。changelog には挙動の変更として記載する。
- Chrome / Firefox が実際に出す候補は拒否しない。対象は mDNS の `.local`、`generation`、`ufrag`、`network-id`、`network-cost`、TCP の port 9、大文字の `UDP`、`raddr 0.0.0.0 rport 0` で、テストで固定する。
- RFC 上は有効だが W3C 属性に写せない候補(component 3 など)は、ICE 層では従来どおり受理する。

### D. 判定基準(契約。JSDoc は `RTCIceCandidateFields`)
根拠: RFC 8839 §5.1(ABNF)、RFC 8445 §5.1.2(priority)、W3C RTCIceCandidate コンストラクター手順 4.2 / 4.3。

| 要素 | 有効な条件 | 違反時 |
| --- | --- | --- |
| 区切り | 単一の空白。空トークン(先頭・末尾・連続空白)や、タブなど他の空白を含むトークンは不可 | 全部 null / fromJSON は拒否 |
| foundation | `ice-char`(`A-Za-z0-9+/`)が 1〜32 文字 | 同上 |
| component-id | 整数 1〜256 | 同上 |
| transport | 空でないトークン | 同上 |
| priority | 整数 1〜2³¹−1 | 同上 |
| connection-address / raddr | IPv4、IPv6、FQDN(mDNS の `.local` を含む)。数字とドットだけの名前は IPv4 でなければならない | 同上 |
| port / rport | 整数 0〜65535 | 同上 |
| `typ` | リテラルの `typ` の後に、空でないトークンが続く | 同上 |
| tcptype | `active` / `passive` / `so` | 同上 |
| generation | 0 以上の整数 | 同上 |
| その他の拡張属性 | 名前と値のトークンが対になっている | 同上 |
| component が 1/2 以外(3〜256) | RFC では有効だが `RTCIceComponent` に写せない(手順 4.3 の invalid value) | 全部 null(ICE 層では受理) |
| protocol が udp/tcp 以外、type が host/srflx/prflx/relay 以外 | W3C の列挙型に写せない | 全部 null(ICE 層では受理) |
| protocol が tcp 以外で tcptype がある | 「protocol が tcp でなければ null」(invalid value ではない) | `tcpType` だけ null |

やらないこと:
- W3C 手順 1 の「sdpMid と sdpMLineIndex がどちらも null なら TypeError」は採用しない。AGENTS.md の方針(werift の利便性を優先し、厳格な挙動は WPT ラッパー側に置く)による。
- `relayProtocol` / `url` は別チケットにする。
- リモート description の a=candidate 行のパーサーは変更しない(negotiation の変更になるため)。この経路の候補は、ICE agent が使う型付きの値から検証する。

### テスト
- 要素 × 4 経路(コンストラクター / `fromSdp` / `fromJSON→toJSON` / `RTCIceTransport` getter の変換)のテーブル駆動テストにする(`tests/transport/iceCandidate.test.ts`、共通の Arrange は `tests/transport/iceCandidateUtils.ts`)。
- これまでの未指摘ケースも含める: foundation `!` と 33 文字、`fromSdp("candidate:…")`、component 3、address `!!!@@` と `999.1.1.1`、raddr `!!!`、UDP の tcptype、派生属性の注入。
- `addIceCandidate` の回帰テスト: 不正な候補は `OperationError` で拒否し、ブラウザー形式の候補は受理する。