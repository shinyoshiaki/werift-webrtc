ICE の keepalive(consent freshness)間隔を見直したい。値は後で決める。対象パッケージ、既定値、公開 API として設定可能にするかは未定。

---

# 詳細化結果

## 1. 目的と背景

- ICE の keepalive は RFC 7675 の consent freshness として実装されている。選択済みペアに対し定期的に STUN Binding Request を送り、有効な応答が途絶えると consent が失効して ICE が `failed` になる。
- 現状の値は `packages/ice/src/iceBase.ts` のモジュール定数で、設定できない。
  - `CONSENT_INTERVAL = 5`(秒)。実際の間隔は 0.8〜1.2 倍にランダム化される(4〜6 秒)。
  - `CONSENT_TIMEOUT = 30`(秒)。最後の有効応答からこの時間が経つと失効する。
  - `CONSENT_RESPONSE_TIMEOUT = 1000`(ms)。RTT 不明時の応答待ち。
  - `CONSENT_RESPONSE_TIMEOUT_MIN = 500`(ms)。RFC 8445 §14.3 の下限。
  - `CONSENT_FAILURES = 6` は deprecated で、現在は使われていない。
- 間隔を見直したい理由は、NAT バインディング維持や切断検知の速さ、および不要なトラフィックの削減。既定値は変更せず、`IceOptions` と webrtc config で間隔・失効の両方を設定可能にする方針とした(詳細は 2 章)。目的の優先順位は 切断検知速度 > NAT 維持 > トラフィック削減。

## 2. 実装すべき変更内容(案)

決定事項(本詳細化で確定):

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| 既定値 | **変更しない**(間隔 5s ±20%、失効 30s) | RFC 7675 の既定そのもので、ブラウザ・ICE-lite 相手との相互接続実績がある。既定を変える具体的な根拠(計測結果や障害報告)は現時点でなく、外れるなら理由の明記が必要になるため |
| 公開 API | **設定可能にする**。`IceOptions` と webrtc 側 config(`iceStunGatherTimeout` / `iceTurnConnectTimeout` と同じ形)に追加 | 用途(NAT が短命な環境、切断を早く知りたい用途、省トラフィック)で最適値が異なり、既定を動かすより利用者が選べる方が安全。既存の timeout 系オプションと同じパターンで追加コストが小さい |
| 対象範囲 | **間隔と失効タイムアウトの両方** | 間隔だけ短くしても失効が 30s のままでは切断検知は速くならず、逆に間隔だけ延ばすと失効までの送信機会が減る。2 つは組で調整する必要がある |
| 目的の優先順位 | **1. 切断検知速度 > 2. NAT バインディング維持 > 3. トラフィック削減** | 失効が `failed` に直結し、再接続や UX に最も影響する。NAT 維持は間隔の上限、トラフィック削減は下限の制約として働く(既定の 5s は一般的な UDP NAT の保持時間より短い) |

命名案: `IceOptions.consentInterval?: number` / `consentTimeout?: number`(秒)、webrtc config は `iceConsentInterval` / `iceConsentTimeout`(未指定は `undefined`)。

バリデーション案: 有限の正数のみ許可し、`consentTimeout >= consentInterval × 1.2 × 2`(失効までに最低 2 回送信できる)を満たさない場合はエラーにする。不正値は黙って既定に戻さない。

実装する場合の変更点:

1. `packages/ice/src/iceBase.ts`
   - `IceOptions` に任意項目を追加する(例: `consentInterval?: number`、`consentTimeout?: number`。単位は秒で、既存の `stunGatherTimeout` や `turnConnectTimeout` に合わせる)。
   - 既存の `CONSENT_INTERVAL` / `CONSENT_TIMEOUT` は既定値として残す。
2. `packages/ice/src/ice.ts`
   - `queryConsent` 内の `randomizedConsentInterval`(約 930 行)で `CONSENT_INTERVAL` の代わりに `this.options.consentInterval ?? CONSENT_INTERVAL` を使う。
   - `refreshConsentExpiry` 内の `CONSENT_TIMEOUT * 1000`(約 908 行)も同様に差し替える。
3. `packages/webrtc/src/secureTransportManager.ts`
   - 約 165 行で `stunGatherTimeout: this.config.iceStunGatherTimeout` を渡している。同じ形で新しい config 項目を `IceOptions` に渡す。
   - webrtc 側の config 型にも項目を追加する(`iceStunGatherTimeout` / `iceTurnConnectTimeout` と同じ場所)。
4. ドキュメントを更新する。
   - `packages/ice/doc/interfaces/IceOptions.md` は `npm run doc` で再生成する。
   - 公開 API を変えるので、README や examples に該当記述があれば更新する。

## 3. 技術調査の要点

- consent の送信ループは `queryConsent`(`packages/ice/src/ice.ts`)にある。
  - 送信間隔は各リクエストの開始時刻を基準にし、応答待ちで間隔が伸びないようにしている(`nextConsentAt`)。
  - 失効タイマー(`consentExpiryTimer`)は送信ループとは独立に動く。
- `retransmissions: 0` で単発送信し、応答待ちは `consentResponseTimeoutMs(rtt)`(2×RTT+200ms、最小 500ms)。
- ICE-lite(`iceLite`)では consent を実行しない。
- 既存の `turnConnectTimeout` / `stunGatherTimeout` が、`IceOptions` から webrtc の config へ通す先行実装になっている。同じパターンに合わせる。
- 既存テストは `packages/ice/tests/ice/consent.test.ts`、`consent-restart.test.ts`、`consent-wire.test.ts`。

## 4. 制約・注意点

- RFC 7675 は間隔を 5s(±20% のジッタ)、失効を 30s と規定している。間隔を延ばしすぎると NAT マッピングが先に失効する恐れがある。短くしすぎるとトラフィックが増え、`CONSENT_RESPONSE_TIMEOUT_MIN`(500ms)との整合も崩れる。
- 失効タイムアウトは、間隔と応答待ちを合わせた時間より十分長く保つ。最低でも 2 回以上の送信機会が必要。不正な組み合わせ(`consentTimeout <= consentInterval` など)や、0・負数・NaN のバリデーション方針を決める。
- ブラウザ(Chrome は約 2.5s 間隔、30s で失効)との相互接続や、ICE-lite 相手(`shouldNominateConsentRequest` による半 aggressive nomination)との挙動を壊さない。
- `CONSENT_FAILURES` は deprecated のまま。互換のため削除しない。
- ICE restart や close 時のライフサイクル(`stopConsentLifecycle`、`consentSessionId`)を変えない。
- 実行環境は Unix 系のみ。

## 5. 完了条件

- [ ] 2 章の決定事項に沿って `packages/ice`(必要なら `packages/webrtc` の config 受け渡しも)に実装されている
- [ ] 未指定の場合は従来どおりの挙動(間隔 5s×0.8〜1.2、失効 30s)になる
- [ ] 不正値(非有限・0 以下・失効が間隔に対して短すぎる組み合わせ)のバリデーションとそのテストがある
- [ ] 既定値が変わっていないことをテストで確認している
- [ ] consent の既存テストが通り、設定値が効くことを確認するテストを追加している(Arrange / Act / Assert、Act / Assert には日本語コメント)
- [ ] `cd packages/ice && npm run type && npm test` が通る。webrtc を変更した場合は `npm run type` と `npm run test:small` も通る
- [ ] `IceOptions` のドキュメントを再生成している(`npm run doc`)
