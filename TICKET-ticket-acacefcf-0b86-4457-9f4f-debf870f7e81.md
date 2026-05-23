## 1. タスクの目的と背景

- 目的は、**単一の公開 TLS アドレスで HTTPS と TURN/TLS を同居**させ、利用者がその 1 アドレスだけを許可すれば **WebRTC の relay-only 通信が成立する最小構成**を **`examples/front-proxy-turn` の動作サンプル**として実装することです。
- 実装先は **`packages/ice-server` 配下のライブラリではなく `examples/front-proxy-turn`** とし、**構成理解と動作確認を目的とするサンプル**として提供します。
- 前提構成は次のとおりです。

```text
Browser WebRTC Client
  |
  | TLS
  v
LB
  |
  | decrypted stream
  v
Relay
  |
  | { clientTransportKey, payload }
  v
Backend TURN
  |
  v
Peer
```

- このサンプルは **WebRTC-only 前提**です。  
  したがって、**汎用 TURN クライアント単体での完全互換**や、relay 切替時の **TCP/TLS stream の完全継続**は完了条件に含めません。
- 今回の本質は、既存の「単一 TLS アドレスで HTTPS と TURN/TLS を同居させる例」を土台に、**LB / Relay / shared KV / Backend TURN に責務分離した最小 front-proxy 構成**へ落とし込むことです。

## 2. 実装すべき具体的な機能や変更内容

### 実装対象

- `examples/front-proxy-turn` にサンプル一式を実装する
- `examples/front-proxy-turn/tests` に unit / integration テストを実装する
- `examples/front-proxy-turn/README.md` に構成、起動方法、制約、非目標を記載する

### 最小構成の責務分担

#### LB

**やること**

- 単一の公開 TLS アドレスを待ち受ける
- TLS を復号する
- **新規接続ごとに relay をランダム選択**する
- relay との stream が失われた場合、**別 relay を再選択**する
- original client source address を relay に渡す
  - 例: PROXY protocol、または同等の内部 envelope

**やらないこと**

- HTTP / TURN の種別判定
- TURN / STUN の解析
- backend TURN の選択
- KV lookup

#### Relay

**やること**

- LB から復号済み stream と original client source address を受ける
- original client source address と public TURN socket 情報から `clientTransportKey` を生成する
- HTTP / TURN を判定する
- TURN/TCP frame を分割する
- 必要な場面だけ TURN `USERNAME` を読む
- KV から backend TURN を解決する
- backend TURN に envelope 付きで転送する

```ts
type RelayToTurnFrame = {
  clientTransportKey: string;
  payload: Buffer;
};
```

#### clientTransportKey

`clientTransportKey` は、TURN の 5-tuple 相当を front-proxy 内部で表す内部キーです。

```text
clientTransportKey =
  originalClientIp
  + originalClientPort
  + publicTurnIp
  + publicTurnPort
  + transport
```

例:

```text
203.0.113.10:53124|34.120.1.10:443|tcp
```

目的は、**relay が変わっても同じ client transport を同じ backend TURN の virtual transport に対応付けること**です。

#### KV の最小構成

最小構成で必要な shared KV は次の 2 つだけです。

- `username -> backend TURN`
- `clientTransportKey -> backend TURN`

#### Backend TURN

**やること**

- `clientTransportKey` ごとに virtual transport を作る
- その virtual transport を TURN の 5-tuple 相当として扱う
- TURN allocation を保持する
- peer との relay を行う
- client 方向の data を現在接続中の relay 経由で返す

```text
clientTransportKey A
  -> virtual transport A
  -> TURN allocation A
```

### routing の詳細

#### HTTP credentials 発行

- Relay が HTTP request を処理し、backend TURN を選択する
- `username -> backend TURN` を保存する
- `username` は backend を判別できる token とする

例:

```text
<backend-id>.<random>.<mac>
```

#### Allocate

- `USERNAME` を読む
- `username -> backend TURN` を引く
- `clientTransportKey -> backend TURN` を保存する
- backend TURN に転送する

#### Refresh / CreatePermission / ChannelBind

- `USERNAME` を読む
- `username -> backend TURN` を引く
- backend TURN に転送する

#### Send indication

- `USERNAME` を前提にしない
- `clientTransportKey -> backend TURN` で解決する

#### ChannelData

- `USERNAME` を持たない
- `clientTransportKey -> backend TURN` で解決する

### relay 再選択時の扱い

- relay が変わっても、同じ `clientTransportKey` を生成できれば、backend TURN の同じ virtual transport に再 attach できる

```text
relay-1
  -> clientTransportKey X
  -> backend TURN virtual transport X

relay-2
  -> clientTransportKey X
  -> backend TURN virtual transport X
```

ただし、以下は最小構成の対象外です。

- relay 障害時に失われた byte / frame の復元
- TCP/TLS stream の完全な無停止継続
- client-LB connection 自体が切れた後の allocation 継続

## 3. 技術的な実装アプローチを調査し結果を簡潔にまとめる

### コードベースから再利用できる要素

- `examples/turn-loopback/server/main.ts`
  - `routeSecureSocket()` が **TLS 復号後の先頭 chunk を見て HTTP / TURN を判定**している
  - 単一 TLS アドレスで HTTPS と TURN/TLS を同居させるサンプルとして最も近い
- `packages/ice-server/src/node/turnServer.ts`
  - `attachTlsSocket()` があり、**外部で TLS 終端した socket を TURN 処理へ handoff**できる
- `packages/ice-server/src/turn/frame.ts`
  - `splitTurnTcpFrames()` が **STUN/TURN message と ChannelData を TCP stream から frame 単位に切り出せる**
- `packages/ice-server/src/turn/protocol.ts`
  - `Allocate` / `Refresh` / `CreatePermission` / `ChannelBind` は `authenticateRequest()` を通る
  - `Send indication` は `XOR-PEER-ADDRESS` と `DATA` を使う
  - `ChannelData` は channel number と payload だけで処理される

### RFC から確認できること

- **RFC 8656 Section 3.2**
  - TURN allocation は **5-tuple** に紐づく
  - TCP では実装が **5-tuple と同等の結果を生む別識別子**を使ってもよい  
    → `clientTransportKey` と backend 側 virtual transport で置き換える設計根拠になる
- **RFC 8656 Section 3.3**
  - permission の作成・更新は **認証可能な transaction** でのみ行う
  - `Send indication` / `ChannelData` は permission 更新に使えない
- **RFC 8656 Section 3.4 / 3.5**
  - `Send indication` は username を持たない
  - `ChannelData` は channel number ベースの軽量 frame で、username を持たない
- **RFC 8445**
  - ICE は TURN の relayed candidate を用いて relay 経由通信を成立させる  
    → このチケットの成功条件は **relay-only な WebRTC 通信が通ること**であり、TURN 単体汎用性ではない

### 実装方針の結論

- **LB は TLS termination と relay selection だけ**を持つ
- **Relay は protocol-aware router** として HTTP / TURN 判定と routing を担当する
- **Backend TURN が TURN state machine の owner** になる
- **Relay は stateless** とし、routing state は shared KV に逃がす
- routing key は `USERNAME` ではなく、**最終的には `clientTransportKey` が本体**になる
- `ufrag` は routing に使わない

## 4. 考慮すべき制約や注意点

- **LB は HTTP / TURN を判定しない**
  - protocol-aware な処理は Relay 側に寄せる
- **Relay の stateless は「process-local pinning を持たない」という意味**
  - システム全体としては shared KV と backend TURN が stateful
- **`clientTransportKey` は relay ローカルの socket 情報から作ってはいけない**
  - 必ず LB から渡された original client source address と public TURN address を使う
- **`Send indication` と `ChannelData` は username で route できない**
  - そのため `clientTransportKey -> backend TURN` が必須
- **relay 再選択後も同じ `clientTransportKey` を再生成できることが前提**
  - ここが崩れると backend 側 virtual transport へ再 attach できない
- **復号済み TCP stream を扱う以上、Relay には frame 分割責務がある**
  - LB は stream をそのまま渡し、TURN/TCP frame の境界復元は Relay が行う
- **最小構成では stream 障害からの完全復元は対象外**
  - frame / byte 欠落の補償、完全無停止フェイルオーバー、client 接続断後の allocation 継続はやらない
- **WebRTC-only 前提**
  - ブラウザ WebRTC が通常通る TURN/ICE シーケンスを対象とし、TURN 単体利用の互換性保証はしない

## 5. 完了条件

1. `examples/front-proxy-turn` にサンプル本体が実装されている。
2. `examples/front-proxy-turn/tests` に unit / integration テストがある。
3. 単一の公開 TLS アドレスで HTTPS と TURN/TLS を受けられる。
4. LB の責務が **TLS termination + relay selection only** に限定されている。
5. Relay が HTTP / TURN を判定し、TURN/TCP frame を分割できる。
6. Relay が HTTP credentials 発行時に backend TURN を選び、`username -> backend TURN` を保存できる。
7. `Allocate` で `USERNAME` から backend TURN を解決し、`clientTransportKey -> backend TURN` を保存できる。
8. `Refresh` / `CreatePermission` / `ChannelBind` を `USERNAME` ベースで正しい backend TURN に転送できる。
9. `Send indication` / `ChannelData` を `clientTransportKey` ベースで正しい backend TURN に転送できる。
10. Backend TURN が `clientTransportKey` ごとの virtual transport を保持し、同じ key で再 attach できる。
11. browser WebRTC client が `iceTransportPolicy: "relay"` 相当の relay-only 構成で接続し、DataChannel または media 通信が成功する。
12. README に構成、責務分担、routing、WebRTC-only 前提、非目標が明記されている。

## 最小設計原則

- **LB**: TLS termination + relay selection only
- **Relay**: HTTP / TURN 判定と backend routing
- **Backend TURN**: TURN state machine owner
- **clientTransportKey**: source transport address 由来の仮想 5-tuple
- **KV**: `username -> backend TURN`, `clientTransportKey -> backend TURN`
- **ufrag**: routing には使わない

この形を、**TURN/TLS front-proxy + shared KV routing + virtual transport backend の最小構成**としてチケット化する。
