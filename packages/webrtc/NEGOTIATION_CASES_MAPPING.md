# Negotiation transaction: individual tests → harness cases

移行前（86e994bf）の `tests/integrate/negotiationTransaction*.test.ts` の決定的な
個別テストと、現在の `tests/negotiation/cases/` のケースとの対応表。ケースは
`tests/negotiation/harness/negotiationCase.ts` のハーネスを使う TypeScript の
Arrange / Act / Assert テスト（`NEGOTIATION_TRANSACTION.md` の "Negotiation
cases"）。途中の版（eb66685a）は独自 DSL のテキストで書いていたが、TypeScript に
戻した（操作・判定は DSL 版と同じ）。すべてのテストは同じファイル名・同じ名前で
1 対 1 に移行し、統合した重複はない（`negotiationCase.for` の `$key` は行の値で
展開され、移行前の `%s` / `$key` と同じ名前になる。vitest が移行前に `'stop'` の
ように引用符を付けていた 5 件だけ表示が変わる）。略記は `NEGOTIATION_SPEC_COVERAGE.md` と同じ。

通信の到達を判定に含み特殊な環境（TURN・simulcast・モック・タイミング指定）を使わない 51 件
（展開 61 件）は、`tests/pbt/model/negotiationModelProperty.test.ts` のモデル property に置き換えた
（表の「→ Model」の行。形式の列にモデル property での扱いを書く）。操作列を固定シーン
（`tests/pbt/model/scenes.ts`、数行の操作のリスト）にしたもの、オラクル（`model/oracles.ts`）と乱数生成で
一般化したもの、具体値の検査を手放した「対象外」がある。検出力の比較は TICKET 2.17。
テスト全体で検出できなくなったバグ（R2・C3・I2）を検出していた 3 宣言（展開 4 件）は TICKET 2.18 で
ケースに戻した（表の「→ Model」が付かない Reg / NT / Route の行）。
TICKET 2.19 では、相手の SDP を通信路上で書き換える操作（`model/wireMutations.ts`）、受信 feedback
（PLI・transport-cc）のオラクル、ICE の選択ペアと DTLS transport の継続のオラクルなどをモデル property に
加え、そのオラクルで判定できる 29 宣言（展開 37 件）を固定シーンに置き換えた（形式の列が
「シーン: …（TICKET 2.19）」の行。2.18 で戻した R2・I2・C3 の 3 宣言も含む）。ICE（EOC・資格情報・
世代）、DTLS role、BUNDLE、RFC の codec 規則の具体値を見るケースは、相互運用に関わるのでケースに残した。
TICKET 2.20 では、ブラウザや他の実装の入力をあえて作るケース（相手の description の書き換え、外部の SDP、
手作りの候補・mDNS 候補、SDP 変異の行列、application 拒否の経路）を削除した（形式の列が「削除（TICKET 2.20…）」の行。
ApplicationRejection・Mutation・EffectiveValues の 3 ファイルは丸ごと削除）。ブラウザとの相互接続は E2E の責務とし、
E2E への追加はしていない。

## 操作・判定の維持

- 操作の順序と検査の時点は移行前のまま。連続操作を独立ケースに分けていない。
  並行操作は `Promise.all([...])` で同じ tick に開始する。
- 期待値はリテラルか、操作前に保存した値。参照同一性は移行前と同じく
  `toBe` / `toContain(obj)` で検査する。
  イベントの回数・順序は `recordNegotiationEvents` などの記録を配列で比較する。
- 実通信（`c.rtp` / `c.data` / `c.alive` / `sendLayer` など）は移行前と同じ送受信の組と
  時点。`waitUntil` / ポーリングは `c.waitFor`（同じ条件とタイムアウト）。
- 記述操作の `{ rejects }` は error 名（または message）に加えて `negotiationSnapshot` の不変を
  検査する。拒否直後の「signalingState・pending/current SDP が直前と同じ」は
  これで置き換え、主要な状態値の expect は 1 行残した。`.rejects.toThrow()` は
  実際の error 名（`InvalidModificationError` など）に固定した（強化）。
- 各記述操作の後の `assertNegotiationInvariants` はランナーが全 peer に対して
  行う（移行前より多い時点）。`explicitInvariants` は CovT [2.8-20]（#142 の
  fixture は移行前も helper を呼ばない）と CovC [5-K14] だけ。
- `expectSessionContinues` は `exempt` 以外の全ケースで最後に実行する。移行前に
  強制していなかった NT・Route・EV・Dev・Matrix のケースにも新たに付いた（強化）。
  `exempt` は移行前の `exemptFromContinuation` と同じ理由のケースに加え、NT の
  "rollback and close drop the transaction's references…"（close が検証対象）と
  "an unsupported offered codec rejects only its m-line"（両 peer に共通の audio
  codec がなく、継続確認が足す transceiver で RTP を運べない）。
- まとめた expect（同じ値・同じ強さ）: 複数の状態値を 1 つの配列・オブジェクトの
  `toEqual` / `toMatchObject` にしたもの（CovE 5-4・2.3-19・2.3-22、CovI 2.7-T4a・2.8-27・
  2.8-35、CovT 2.2-8・2.8-18・5-2、Reg の両 peer ループ、NT の
  "rollback preserves application stop…"）。
- 書き換えた判定（同値またはより強い）: 未定義キーの `toBeUndefined()` →
  `expect(Object.keys(table)).not.toContain("<key>")`（キー自体がないこと）。NT の最初の trickle
  ケースの live checklist 件数は host+port → port の一致（他で使わない port）。
  Reg "close() while createAnswer() prepares…" の自明な `toHaveLength(2)` →
  `mids.length` が 3。Reg の checksSettled ループは並列化（各 transport 1000ms 以内は同じ）。
  CovE 2.3-22 の `dataChannels.length > 1` → 2 と一致（次の行で長さ 2 を検査）。
- Arrange の変更: 受信 track の取得を `onRemoteTransceiverAdded`→`onTrack` の購読から
  `recordNegotiationEvents(b).tracks` へ（onTrack の回数を数えるケースは `vi.fn()` の
  購読のまま）。NT "an offer created by another peer… connected" は
  未接続 peer + `c.negotiate(a)`。
  CovT・Matrix の方向付きケースは `createDirectedDuplexSession(from)` で `a` を
  offerer にし、継続確認の順序を移行前の `(offerer, answerer)` に合わせた
  （AppRej の宣言ケースだけ移行前の `(b, a)` が `(a, b)` になった）。
- テストごとの timeout（10s / 15s）は既定の 60s に（継続確認が加わったため）。
- Dev の TURN 3 ケース（"end-of-candidates is signalled once…"、"only the latest
  generation keeps a TURN allocation"、"an unapplied restart offer…"）は、継続確認の
  前に初回接続の DataChannel が開くのを待つ（`c.waitFor(() => channel.readyState === "open")`）。
  接続途中の再交渉で SCTP が両側 COOKIE_WAIT に残る事象を移行中に観測した（8 回中 4 回、
  未調査）。移行前のテストは継続確認をしていなかったので、移行前の判定は変わらない。

## 表駆動のまま残したもの

| ファイル | ケース | 理由 |
| --- | --- | --- |
| Intr | `$interrupt while waiting on $wait` | 割り込みと保留した待ちの解放を同じ同期 tick で始める必要があり、ステップを分けると間に microtask が入る。close 後のリーク検査は継続確認の後に行う。`negotiationTest` フィクスチャへ移した |
| CloseTiming | `$operation closed after $ticks` | microtask 数（0〜10 と macrotask）を数える行列 |
| AppRej（TICKET 2.20 で削除） | `$name`（PATHS） | 行ごとの Act 関数と、`sctpTransport` による実行時の分岐、継続確認の後の DataChannel 検査 |
| Mut（TICKET 2.20 で削除） | `$phase $stage mutated by $name` | `WERIFT_NEGOTIATION_MUTATION` で組み合わせが決まり、受理・拒否で制御が分かれる（動作と環境変数は変更なし） |

## 対応表

| ファイル | 旧テスト（= 新ケース名） | 展開数 | 形式 | ref（仕様 ID・由来） |
| --- | --- | --- | --- | --- |
| CovC | [2.4-T7b] NACK, transport-cc and PLI follow the codec of each packet, not the lowest payload type | 1 | ケース | 2.4-T7b |
| CovC → Model | [2.4-4] a remote pranswer that changes codec, RTX, RED and header extensions of the senders is fully undone by rollback | 1 | オラクル: rollback（送信パラメータ）。codec を変える pranswer は生成しない | 2.4-4 |
| CovC → Model | [2.4-5] transport-cc feedback a re-offer adds starts only at the answer commit | 1 | シーン: "transport-cc feedback a re-offer adds starts only at the answer commit"（TICKET 2.19） | 2.4-5 |
| CovC | [2.4-5] transport-cc feedback a pranswer packet started stops on rollback | 1 | ケース | 2.4-5 |
| CovC | [2.4-7] a transceiver for a remote offer does not take the m-line of a committed inactive transceiver | 1 | ケース | 2.4-7 |
| CovC → 削除 | [2.4-7] a remote offer that puts a new MID on a committed inactive (not rejected) m-line does not take it | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.4-7 |
| CovC | [2.4-7] an unassociated inactive addTransceiver() is associated by a remote offer only within the documented constraint and keeps its direction | 1 | ケース | 2.4-7 |
| CovC → Model | [2.5-16] createAnswer only proposes: sender, receive codec / RTX tables, TWCC and the remote track codec switch at the local answer commit | 1 | オラクル: create（送信パラメータと受信表が変わらない） | 2.5-16 |
| CovC | [2.5-17] a rolled-back local offer leaves no pendingLocalOfferCodecs and the next offer resolves as before | 1 | ケース | 2.5-17 |
| CovC | [2.5-17] a rolled-back remote offer restores the re-resolution request an unapplied createOffer consumed while it was pending | 1 | ケース | 2.5-17 |
| CovC | [2.6-T1b] the configured SCTP MTU is kept when SCTP moves to another DTLS transport, on rollback and at the answer | 1 | ケース | 2.6-T1b |
| CovC | [2.6-T4e] answering with a track source codec does not adopt it into the configured codecs | 1 | ケース | 2.6-T4e |
| CovC | [2.6-T4g] a remote answer keeps the answerer's codec order for the offerer's codecs and sender | 1 | ケース | 2.6-T4g |
| CovC → Model | [2.6-T4h] the local answer commit $change transport-cc with the answered codec without a preference change | 2 | 対象外（transport-cc の開始・停止の時点） | 2.6-T4h |
| CovC → Model | [2.8-36] a remote-created transceiver the application keeps returns to its created codecs and has no routes after rollback | 1 | シーン: "a remote-created transceiver the application gave a track survives the rollback of a first pranswer in its created state"（TICKET 2.19） | 2.8-36 |
| CovC → Model | [2.8-39] rolling back a first pranswer returns both peers' send and receive codecs to the unnegotiated state | 1 | シーン: "a first pranswer sends with the codec it answered and its rollback returns both peers' codecs to the unnegotiated state"（TICKET 2.19） | 2.8-39 |
| CovC → Model | [5-7] PLI stays negotiated after a rolled-back re-offer that removes NACK/PLI for the same SSRC | 1 | シーン: "PLI stays negotiated after a rolled-back re-offer that removes it"（TICKET 2.19） | 5-7 |
| CovC | [5-7] PLI follows the receive codec table $negotiated NACK/PLI, not a remote track codec rewritten $rewritten it | 2 | ケース | 5-7 |
| CovC → Model | [5-13] RTX packets resolve to the current media SSRC while a re-pairing is pending and after $finish | 2 | シーン: "an RTX SSRC a re-offer pairs with a new media SSRC keeps its current pairing until %s"（TICKET 2.19） | 5-13 |
| CovC → 削除 | [5-13] RTP that carries a header extension under its new id arrives after the answer commits the move | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 5-13 |
| CovC → Model | [5-13] RTP received while a fmtp change is staged is decoded with the current fmtp until $finish | 2 | 対象外（fmtp の staging） | 5-13 |
| CovC → 削除 | [5-K14] an m-line outside the offered BUNDLE group offered with a=setup:active is answered passive (RFC 8842 section 5.3) | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 5-K14 |
| Mut → 削除 | $phase $stage mutated by $name | 162 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | — |
| Reg | a relay-only ICE restart offered by $offerer nominates once the held TURN allocation completes after the peer's candidates | 2 | ケース | 2.11-14; origin: property test |
| Reg | close() from the stable event of a glare implicit rollback adds no pending offer and leaves no transport running | 1 | ケース | 2.11-15; origin: property test |
| Reg | close() from the stable event of a new local offer that rolls a remote pranswer back adds no pending offer and leaves no transport running | 1 | ケース | 2.11-15; origin: property test |
| Reg → Model | rollback of a remote offer after the application's $operation keeps the remote-created transceiver only when it has a track (as develop) | 5 | シーン: "rollback of a remote offer removes the transceiver it created after the application's %s (as develop)"、"a remote-created transceiver the application gave a track survives the rollback of a first pranswer in its created state"（TICKET 2.19） | 2.12-3; origin: property test (develop comparison) |
| Reg | a bundlePolicy disable renegotiation pranswer does not fail the connection and the final answer connects | 1 | ケース | 2.12-2; origin: property test |
| Reg | a simulcast layer whose MID extension names no route is still routed by its RID (as develop) | 1 | ケース | 2.12-5; origin: property test (develop comparison) |
| Reg → 削除 | addIceCandidate does not wait for the gathering of a setLocalDescription before it (as develop) | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.12-6; origin: property test (develop comparison) |
| Reg → 削除 | an ICE-lite peer's final answer with new credentials and generation 1 candidates connects without another restart | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.12-10; origin: property test |
| Reg → Model | a replacement local offer keeps a new transceiver associated with its m-line | 1 | 固定シーン「a replacement offer keeps a new transceiver on its m-line」 | 2.1-T5; origin: property test |
| Reg → Model | an answer does not give a direction to a transceiver without an m-line | 1 | シーン: "an answer does not give a direction to a transceiver without an m-line"（TICKET 2.19） | origin: property test |
| Reg → Model | MIDs from unapplied createOffer calls do not collide with a later remote offer | 1 | 固定シーン「MIDs an unapplied createOffer reserved …」 | origin: property test |
| Reg | the final answer after an ICE restart pranswer reuses the pranswer credentials | 1 | ケース | 2.9-7; origin: property test |
| Reg → Model | a remote pranswer that changes send parameters is fully undone by rollback | 1 | シーン: "a remote pranswer that changes send parameters (no RTX) is fully undone by rollback"（TICKET 2.19） | 2.2-9 2.4-4; origin: self-review (live state) |
| Reg → Model | a re-offer that changes RTCP feedback of a current payload type is staged until commit | 1 | シーン: "a re-offer that changes the RTCP feedback of a current payload type is staged until commit"（TICKET 2.19） | 2.4-T7a; origin: self-review (live state) |
| Reg → Model | a pending re-offer that adds transport-cc does not start TWCC feedback for the current stream | 1 | 対象外（transport-cc の開始時点） | 2.4-5; origin: self-review (live state) |
| Reg | a transceiver created for a remote offer does not make negotiation needed | 1 | ケース | 2.3-20 2.4-6 5-K6; origin: self-review (live state) |
| Reg → Model | a final answer replaces the RTCP feedback a pranswer staged | 1 | 対象外（RTCP feedback の staging） | 2.4-T7a 2.5-13; origin: self-review (live state) |
| Reg | adding video after an inactive audio m-line does not take the audio m-line | 1 | ケース | 2.4-7; origin: self-review (live state) |
| Reg → 削除 | an answer whose codec was not in the offer is rejected before mutation | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.5-4; origin: self-review (live state) |
| Reg → 削除 | $candidate after end-of-candidates of an ICE restart pranswer reaches neither the pending SDP nor the provisional checklist | 2 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 5-12; origin: self-review (live state) |
| Reg → 削除 | an mDNS candidate that is still resolving does not hold later candidates or description operations | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.8-1; origin: self-review (live state) |
| Reg → 削除 | an mDNS candidate trickled before end-of-candidates of an ICE restart pranswer is kept | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.7-T2 2.8-2 2.8-29 5-12; origin: self-review (live state) |
| Reg → Model | a sender added during a rolled-back offer keeps receiving RTCP after renegotiation | 1 | 固定シーン「a sender added during a rolled-back offer carries traffic …」（RTCP の到達は対象外） | 5-8; origin: self-review (live state) |
| Reg → Model | PLI stops at the commit of a re-offer that removes NACK/PLI for the same SSRC | 1 | シーン: "a PLI request needs nack pli: a generic nack alone does not allow it"（TICKET 2.19） | 5-7; origin: self-review (live state) |
| Reg → Model | PLI starts only at the commit of a re-offer that adds NACK/PLI for the same SSRC | 1 | シーン: "PLI a re-offer adds starts only at its answer commit, not while pending or after a rollback"（TICKET 2.19） | 2.4-T7b 5-7 5-13; origin: self-review (live state) |
| Reg → 削除 | header extension IDs the answer did not accept stay free for a later offer | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.8-16; origin: self-review (live state) |
| Reg → 削除 | a payload type the answer did not accept can carry another codec in a later remote offer | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.8-16; origin: self-review (live state) |
| Reg | close() during a pending BUNDLE split stops the transports the proposal prepared | 1 | ケース | 2.8-17; origin: self-review (live state) |
| Reg | a local pranswer applied again over a connected BUNDLE split keeps its checks settled through the final answer and close() | 1 | ケース | 2.12-9; origin: self-review (live state) |
| Reg | close() after a provisional split connection stops both peers' pending transports | 1 | ケース | 2.2-3 2.7-3 2.8-17; origin: self-review (live state) |
| Reg → Model | an ICE restart commit does not wait for an unreachable STUN server | 1 | 対象外（到達しない STUN の待ち時間） | 2.8-4; origin: self-review (live state) |
| Reg | restartIce() beside a new m-line with bundlePolicy disable offers the new transport's gathered candidates | 1 | ケース | 2.8-7; origin: self-review (live state) |
| Reg → 削除 | a re-answer with a=setup:actpass keeps the DTLS role of the live association | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.8-47 2.11-5; origin: self-review (live state) |
| Reg | close() while an ICE restart answer commits keeps the state closed | 1 | ケース | 2.8-19; origin: self-review (live state) |
| Reg → Model | a remote re-offer committed by the local answer switches the receive tables and the remote track codec | 1 | オラクル: create・commit で一部（受信表の切り替え時点） | 2.5-16 2.6-T4h; origin: self-review (live state) |
| Reg → Model | codec preferences resolved by createAnswer apply to live receive tables only at the answer commit | 1 | シーン: "codec preferences createAnswer resolves change the live tables only at the answer commit"（TICKET 2.19） | 2.5-16 2.6-T4a; origin: self-review (live state) |
| Reg | an answer applied during the DTLS handshake keeps the connected ICE state | 1 | ケース | 2.8-23 2.8-24 2.8-26; origin: self-review (live state) |
| Reg | an answer without an ICE restart leaves a failed ICE generation failed | 1 | ケース | 2.8-23 2.8-24 2.8-27; origin: self-review (live state) |
| Reg | an ICE restart keeps the configured icePasswordPrefix | 1 | ケース | 2.8-11; origin: self-review (live state) |
| Reg | the local answer lists codecs in the answerer's preference order | 1 | ケース | 2.6-T4g; origin: self-review (live state) |
| Reg → Model | a codec the local answer dropped leaves the receive table even when the re-offer staged it | 1 | シーン: "a codec the local answer drops leaves the receive table although the re-offer staged it"（TICKET 2.19） | 2.8-45; origin: self-review (live state) |
| Reg → 削除 | end-of-candidates trickled on a non-tag BUNDLE m-line completes the restarted generation | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.8-28; origin: self-review (live state) |
| Reg → 削除 | a final answer cannot reverse the DTLS role a first pranswer connected with | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.8-33; origin: self-review (live state) |
| Reg → Model | rolling back a first pranswer connection resets the public connection states | 1 | シーン: "a first pranswer connects provisionally and its rollback lets the next negotiation connect"（TICKET 2.19） | 2.2-17 2.8-35; origin: self-review (live state) |
| Reg → Model | a remote-created transceiver the application keeps returns to its created state on rollback | 1 | シーン: "a remote-created transceiver the application gave a track survives the rollback of a first pranswer in its created state"（TICKET 2.19） | 2.3-5 2.8-36; origin: self-review (live state) |
| Reg | a saved answer commits its own codecs after an unapplied createOffer() resolved others | 1 | ケース | 2.8-37 2.8-38 2.9-8 2.9-T1; origin: self-review (live state) |
| Reg → Model | a first pranswer sends and receives with the codecs it answered | 1 | シーン: "a first pranswer sends with the codec it answered and its rollback returns both peers' codecs to the unnegotiated state"（TICKET 2.19） | 2.8-39; origin: self-review (live state) |
| Reg → Model | a re-applied restart offer that fails to parse leaves no staged credentials | 1 | 生成器の古い offer の適用＋reject（拒否は状態を変えない）で一部 | 2.9-4 2.9-9; origin: self-review (live state) |
| Reg → Model | a remote answer that answers only the leading m-lines of the offer is accepted and rejects the rest | 1 | 対象外（相手の SDP を書き換える必要がある） | 2.9-T9; origin: self-review (live state) |
| Reg → Model | a first offer with a DataChannel re-applied after its rollback opens the channel | 1 | 固定シーン「a DataChannel created between createOffer and applying that older offer」 | 2.3-15 2.9-10 2.9-T5; origin: self-review (live state) |
| Reg | a max-compat first offer connects to a peer that answers without BUNDLE | 1 | ケース | 2.8-41 2.8-42; origin: self-review (live state) |
| Reg → 削除 | a candidate on the tag m-line after end-of-candidates on a non-tag member of a pending restart is ignored | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.8-32; origin: self-review (live state) |
| Reg | close() while createAnswer() prepares the transports of a BUNDLE split leaves none running | 1 | ケース | 2.8-18; origin: self-review (live state) |
| Reg → 削除 | end-of-candidates on a pending restart reaches its BUNDLE group but not an m-line the offer splits off | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.8-31; origin: self-review (live state) |
| Reg → 削除 | an answer declining BUNDLE onto the same transport keeps the ended generation complete | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.8-28 2.10-6; origin: SDP mutations |
| Reg → 削除 | new remote credentials next to an inactive m-line keep only the new remote generation's candidates | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.11-13; origin: SDP mutations |
| Reg → 削除 | new remote credentials in an answer keep the local credentials the offer described | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.10-5; origin: SDP mutations |
| Reg → 削除 | a rejected m-line does not turn a credential change into a renomination | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.10-5; origin: SDP mutations |
| CovT → 削除 | [2.2-8] a replacement pranswer's DTLS fingerprint and role take effect on a new association that has not started | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.2-8 |
| CovT → Model | [2.2-8] a replacement pranswer that adds BUNDLE detaches the transports a no-BUNDLE pranswer used and stops their checks | 1 | 対象外（相手の SDP の BUNDLE を書き換える必要がある） | 2.2-8 |
| CovT → Model | [2.2-13] a final answer that rejects the application m-line keeps the SCTP association a first pranswer opened, as develop does | 1 | 対象外（application m-line の拒否） | 2.2-13 2.11-2; origin: develop comparison |
| CovT → 削除 | [2.2-13] the candidates of a pranswer generation the final answer replaced leave the live checklist | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.2-13 |
| CovT → Model | [2.2-16] rollback stops the RTP a renegotiation pranswer started and keeps the current stream | 1 | 固定シーン「a renegotiation pranswer carries a new stream …」 | 2.2-16 |
| CovT | [2.8-18] close() while a local offer stages the transports of a BUNDLE split leaves none running | 1 | ケース | 2.8-18 |
| CovT → 削除 | [2.8-20] a first answer's own MIDs are read as the offered MIDs in BUNDLE, and a later answer must match exactly | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.8-20 |
| CovT | [2.8-41] a $bundlePolicy first offer keeps each m-line on its own transport and candidates until an answer accepts BUNDLE | 2 | ケース | 2.8-41 |
| CovT | [2.8-43] a max-bundle first offer shares the tag's transport at the offer | 1 | ケース | 2.8-43 |
| CovT | [2.8-43] an m-line added to a session whose peer accepted BUNDLE shares the tag's transport at the offer | 1 | ケース | 2.8-43 |
| CovT → 削除 | [2.8-47] an actpass answer makes a new association the DTLS client | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.8-47 |
| CovT → Model | [2.9-T8] the same offer replaces a pranswer a first negotiation connected and the final answer reconnects | 1 | 固定シーン「a replacement offer implicitly rolls back a first pranswer connection」 | 2.9-T8 |
| CovT → 削除 | [5-11] staged topology, candidate delivery, DTLS role and the answer's tags apply to the second BUNDLE group | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 5-11 |
| CovT → 削除 | [2.5-T3] an answer to an m-line outside the BUNDLE group offered with a=setup:active is passive | 2 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.5-T3 |
| CovT → Model | [5-2] an m-line without a common codec, its port 0 answer and duplicate applications keep the invariants | 2 | 生成器の codec preferences で一部（共通 codec のない m-line） | 5-2 |
| CovE → Model | [2.1-T6] a replacement offer and its rollback repeat no delivered event and close the replacement's pending-only transports | 1 | オラクル: events・rollback＋生成器の置き換え offer | 2.1-T6 |
| CovE → Model | [2.3-1] a remote pranswer fires ontrack once before the final answer | 1 | オラクル: events（track の重複なし） | 2.3-1 |
| CovE → Model | [2.3-2] rollback keeps the receiver and track and restores the last-stable stream association | 1 | オラクル: rollback（受信表）。stream の付け替えは生成しない | 2.3-2 |
| CovE → Model | [2.3-4] ontrack repeats only for a real stream addition or a transition to receiving | 1 | オラクル: events（track は受信への遷移かストリームの変化でだけ通知） | 2.3-4 |
| CovE → Model | [2.3-7] a remote-created transceiver kept by addTrack carries the next local offer | 1 | 対象外（pending 中の addTrack は生成しない） | 2.3-7 |
| CovE | [2.3-7] rollback leaves no candidate of the rolled-back offer on the kept transceiver's transport | 1 | ケース | 2.3-7 |
| CovE | [2.3-14] $outcome closes a remote-created channel of a pending-only association and drops it from the registry | 2 | ケース | 2.3-14 |
| CovE → Model | [5-4] channels of a committed association stay open through a renegotiation rollback | 1 | 固定シーン「channels of a committed association stay open …」＋オラクル channels | 5-4 |
| CovE → Model | [2.3-19] an ICE restart pranswer and its rollback notify only real signaling transitions | 1 | オラクル: events（signalingstatechange） | 2.3-19 |
| CovE | [2.3-19] rolling back a connection made at the first pranswer notifies only the new transitions | 1 | ケース | 2.3-19 |
| CovE | [2.3-19] negotiationneeded waits for stable and is recomputed once after rollback | 1 | ケース | 2.3-19 |
| CovE → Model | [2.3-21] re-applying the same pranswer creates no new channel, transceiver or event | 1 | オラクル: idempotent（同じ remote description の再適用） | 2.3-21 |
| CovE → Model | [2.3-22] a DCEP reusing a stream ID on a new association after rollback creates a new channel | 1 | 対象外（DCEP の stream ID の再利用） | 2.3-22 |
| CovE | [2.3-24] a DCEP held past rollback is not delivered, while the provisional channel still gets its close event | 1 | ケース | 2.3-24 |
| CovI | [2.7-T4a] the final answer checks the restarted generation from scratch instead of taking the provisional nomination | 1 | ケース | 2.7-T4a |
| CovI | [2.7-T4b] $replacement ends the provisional generation of a restart pranswer and the live pair keeps carrying RTP | 2 | ケース | 2.7-T4b |
| CovI | [2.8-5] an ICE restart without ICE servers puts end-of-candidates in its descriptions and trickles nothing after the commit | 1 | ケース | 2.8-5 |
| CovI | [2.8-27] an answer that starts no connection work leaves a $state connectionState unchanged | 2 | ケース | 2.8-27 |
| CovI → Model | [2.8-29] end-of-candidates on a non-tag m-line completes the provisional generation of a restart pranswer for its whole BUNDLE group | 1 | 対象外（restart pranswer の非 tag m-line の EOC） | 2.8-29 |
| CovI | [2.8-35] after the $side rolls back a first pranswer connection it reports no later state of that connection | 2 | ケース | 2.8-35 |
| CovI → 削除 | [5-12] an mDNS candidate of a restart pranswer still resolving at $interruption reaches neither the SDP nor any checklist | 2 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 5-12 |
| CovI | [2.6-T3a] ICE servers set while an ICE restart is pending survive its rollback and apply to the next restart | 1 | ケース | 2.6-T3a |
| CovI | [2.6-T3b] ICE servers set after a restart offer was created apply to that restart's gathering at its commit | 1 | ケース | 2.6-T3b |
| AppRej → 削除 | $name (PATHS) | 7 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | — |
| AppRej → 削除 | an application created after the answerer rejected it takes the rejected position with a new MID | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.11-1 2.11-4 |
| NT → Model | rollback preserves application stop and a new trackless transceiver | 1 | オラクル: rollback（アプリが足した transceiver は MID なしで残る）。pending 中の stop は生成しない | 2.5-15 |
| NT → 削除 | a remote offer whose BUNDLE member is not an exact MID creates nothing | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.8-20; origin: BUNDLE group validation |
| NT | a replacement local offer whose transport preparation fails keeps the earlier pending offer | 1 | ケース | 2.9-9 |
| NT | rollback keeps simulcast SSRCs learned $when | 2 | ケース | 2.4-1; origin: simulcast SSRC learning |
| NT → Model | rollback keeps a DataChannel created $when and the next negotiation opens it | 3 | 固定シーン「a DataChannel created during a first offer …」「… the answerer creates in have-remote-offer …」「… created between createOffer and applying that older offer」「the first SCTP transport a DataChannel creates during an offer survives its rollback」＋オラクル channels | 2.3-15 2.3-17 2.3-18 |
| NT → Model | an answer whose RTX has no associated codec is rejected before mutation | 1 | 対象外（相手の SDP を書き換える必要がある） | 2.5-4 |
| NT | a remote offer that fails while applying leaves no partial state | 1 | ケース | 2.1-11 5-K3 |
| NT | an answer that fails while applying returns to its pending offer | 1 | ケース | 2.1-11 2.1-T13 |
| NT | an ICE restart answer that fails while applying keeps the committed generation and pair | 1 | ケース | 2.1-11 |
| NT | a queued candidate that the answer cannot place rejects the answer before commit | 1 | ケース | 2.7-3; origin: candidate queue |
| NT → Model | a trickle candidate of the unchanged ICE generation reaches the live checklist during a re-offer | 1 | シーン: "a candidate of the unchanged generation trickled during a re-offer without end-of-candidates reaches the live checklist"（TICKET 2.19） | origin: same-generation trickle during a re-offer |
| NT → Model | candidates in the body of a same-ufrag re-offer reach the live checklist before the answer | 1 | 対象外（offer 本文の候補の配送） | origin: same-generation candidates in an offer body |
| NT → Model | end-of-candidates on a non-tag BUNDLE m-line completes the shared transport for every m-line | 1 | 対象外（非 tag m-line の EOC の整合） | 2.8-28 |
| NT → Model | end-of-candidates trickled on a non-tag m-line during a same-ufrag re-offer stays aligned after $finish | 2 | 対象外（同上） | 2.8-30 |
| NT → Model | end-of-candidates in the body of a non-tag m-line of a same-ufrag re-offer ends the shared generation after $finish | 2 | 対象外（同上） | 2.8-30 |
| NT | a queued candidate the remote offer cannot place rejects it before any application event | 1 | ケース | origin: candidate queue |
| NT | createOffer called while setLocalDescription is running does not invalidate that offer | 1 | ケース | origin: operations chain |
| NT | createAnswer called while setRemoteDescription is running answers that offer | 1 | ケース | origin: operations chain |
| NT → Model | a candidate's ufrag in the candidate string routes it to the same generation as the usernameFragment property | 1 | 対象外（候補文字列の ufrag による振り分け） | 2.3-22 |
| NT → Model | during a partial BUNDLE split re-offer a candidate follows the ufrag of the m-line it targets | 1 | 対象外（部分的な BUNDLE 分割での候補の振り分け） | origin: partial BUNDLE split trickle |
| NT → Model | an answer leaves the MID of a rejected m-line out of its BUNDLE group | 1 | invariant（BUNDLE）＋生成器の stop で一部 | 2.5-14 |
| NT | rollback and close drop the transaction's references to closed or unused objects | 1 | ケース | origin: transaction references |
| NT → Model | a pending payload type leaves the receiver codec table by rollback | 1 | シーン: "a payload type a re-offer adds is live while pending and leaves the receive table at rollback"（TICKET 2.19） | 2.4-1 2.4-3 5-13 |
| NT → Model | ICE restart pranswer connects a pending generation and rollback keeps current RTP | 1 | シーン: "a local ICE restart and a restart pranswer roll back to the committed generation"（TICKET 2.19） | 2.2-3 2.7-T2 |
| NT → Model | ICE restart pranswer over a connected SCTP association checks the new generation, then $outcome | 2 | シーン: "a local ICE restart and a restart pranswer roll back to the committed generation"、"a restart pranswer is committed by the final answer"（TICKET 2.19） | 2.1-3 2.1-5 2.1-T4 2.1-T8 2.2-6 2.2-16 2.3-16 2.7-T3 2.7-T4b |
| NT → Model | rollback removes remote-only objects and a repeated offer does not duplicate events | 1 | シーン: "a remote offer applied twice and rolled back notifies its objects once and removes them"（TICKET 2.19） | 2.1-7 2.1-10 2.1-T1 2.2-2 2.3-1 2.3-3 2.3-4 2.3-6 2.3-8 2.3-21 2.3-23 5-4 |
| NT → Model | rollback keeps a remote-created transceiver that received a local track | 1 | シーン: "a remote-created transceiver the application gave a track survives the rollback of a first pranswer in its created state"（TICKET 2.19） | 2.3-5 2.3-7 2.8-36 |
| NT → Model | rollback removes provisional receiver SSRC mappings on an existing track | 1 | オラクル: rollback（経路と受信表） | 2.3-2 2.4-3 2.4-T6 |
| NT | setLocalDescription accepts only the last created offer | 1 | ケース | 2.9-4 2.9-T10 2.9-T11 |
| NT | an offer created by another peer is rejected by $peer | 2 | ケース | 2.9-4 |
| NT | an unsupported offered codec rejects only its m-line | 1 | ケース | origin: codec intersection per m-line |
| NT | initial pranswer starts provisional DataChannel traffic and rollback closes it | 1 | ケース | 2.1-T4 2.2-4 2.2-5 2.2-16 2.2-17 2.3-13 2.3-14 2.3-16 |
| NT → 削除 | initial pranswer carries provisional RTP before final commit | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.1-T1 2.2-1 2.2-2 2.3-1 2.3-3 2.3-6 2.7-3 5-3 |
| NT → Model | re-offer pranswer carries new RTP alongside the committed stream | 1 | 固定シーン「a renegotiation pranswer carries a new stream …」＋オラクル traffic | 2.1-3 2.2-1 2.2-5 2.2-6 2.2-7 |
| NT → Model | a final answer can replace provisional SCTP limits without another channel event | 1 | シーン: "a replacement pranswer and the final answer change the provisional max-message-size without a second channel event"（TICKET 2.19） | 2.2-5 2.2-12 2.2-15 2.3-18 5-4 |
| NT → Model | duplicate trickle candidate and EOC are idempotent within one generation | 1 | シーン: "a described candidate and end-of-candidates trickled twice change nothing"（TICKET 2.19） | 2.1-10 2.3-21 |
| NT → Model | both peers commit matching local and remote ICE restart generations | 1 | シーン: "a restart pranswer is committed by the final answer"（TICKET 2.19） | 2.1-T7 2.2-3 2.2-6 2.7-T1 2.7-T3 2.7-T4a 5-K6 |
| NT → Model | local ICE restart rollback retains the committed selected pair | 1 | 固定シーン「a local ICE restart and a restart pranswer roll back …」＋オラクル rollback | 2.1-7 2.1-T8 2.3-9 2.3-11 5-4 |
| NT → 削除 | partial BUNDLE keeps an unbundled media transport independent | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | origin: partial BUNDLE (RFC 8843 7.3.2) |
| NT → Model | re-offer BUNDLE split stages a new owner and rollback discards it | 1 | 固定シーン「a local BUNDLE split carries both streams, and its rollback keeps the old owner」 | 2.1-T9 2.3-9 2.5-T1 2.5-11 2.5-12 |
| NT → Model | a local BUNDLE split prepares independent ICE and carries both RTP streams | 1 | 同上 | origin: local BUNDLE split |
| NT → Model | rollback of a local BUNDLE split keeps the old RTP owner | 1 | 同上 | 2.1-T9 2.5-11 |
| NT → Model | replacement offers implicitly roll back either pranswer direction | 1 | 固定シーン「a replacement offer implicitly rolls back a first pranswer connection」 | 2.1-6 2.1-T12 2.2-18 2.8-34 2.9-T8 |
| NT → 削除 | description and trickle operations serialize, and a rolled-back ufrag cannot be buffered | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | origin: operations chain |
| Intr | $interrupt while waiting on $wait | 13 | 手続き型 | — |
| Dev | a TURN server set before a restart offer is gathered at the commit and trickled | 1 | ケース | 2.6-T3b 2.8-6; origin: develop #688 / #731 |
| Dev | an ICE restart with TURN trickles a fresh relay candidate after the commit | 1 | ケース | 2.3-9 2.6-T3c 2.8-6; origin: develop #688 / #731 |
| Dev | end-of-candidates is signalled once, when the latest generation completes | 1 | ケース | 2.3-10 2.3-11 2.3-12 2.8-8 2.8-9; origin: develop #688 / #731 |
| Dev | only the latest generation keeps a TURN allocation | 1 | ケース | 2.6-T3c 2.8-9; origin: develop #688 / #731 |
| Dev | an unapplied restart offer does not change the applied description the gathering refreshes | 1 | ケース | 2.8-13; origin: develop #688 / #731 |
| Dev | close() during a restart's background TURN gathering leaves no allocation | 1 | ケース | 2.3-12 2.3-24 2.8-8; origin: develop #688 / #731 |
| Dev | an offer with several H264 variants is answered with only the configured one | 1 | ケース | 2.6-T4f; origin: develop #729 |
| Dev → Model | setCodecPreferences between createAnswer and setLocalDescription commits the answer's codec | 1 | シーン: "codec preferences changed between createAnswer and setLocalDescription commit the answer's codec"（TICKET 2.19） | 2.6-T4c 2.6-T4h 2.8-38; origin: develop #729 |
| Dev → Model | addTrack between createAnswer and setLocalDescription sends with the answer's codec | 1 | シーン: "a track attached between createAnswer and setLocalDescription sends with the answer's codec"（TICKET 2.19） | 2.6-T4a 2.6-T4c; origin: develop #729 |
| Dev | setCodecPreferences during a pending offer survives its rollback | 1 | ケース | 2.5-17 2.6-T4b; origin: develop #729 |
| Dev | replaceTrack during a pending re-offer rejects a track the answer's codec cannot carry | 1 | ケース | 2.6-T4d; origin: develop #729 |
| Dev | a track attached during a rolled-back pranswer gets the restored codec | 1 | ケース | 2.5-17; origin: develop #729 |
| Dev | a local offer reuses a stopped m-line only for a transceiver of the same kind | 1 | ケース | 2.5-6 2.8-46; origin: develop #721 / issue 705 |
| Dev | a transceiver added during a rolled-back offer does not keep the stopped m-line index | 1 | ケース | 2.1-T10 2.6-T2; origin: develop #721 / issue 705 |
| Dev | an SCTP transport a remote offer creates uses the configured MTU | 1 | ケース | 2.6-T1a; origin: develop #716 |
| Dev | the MTU is fixed while a remote offer's SCTP transport is pending and free again after rollback | 1 | ケース | 2.6-T1c; origin: develop #716 |
| CloseTiming | $operation closed after $ticks | 120 | 手続き型 | — |
| Route → 削除 | a remote re-offer that remaps an active header extension id is rejected before mutation | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.4-T2a |
| Route → 削除 | a remote re-offer that swaps the active MID and RID extension ids is rejected before mutation | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.4-T2a |
| Route → 削除 | a URI moved to a new header extension id keeps current RTP parsed through $finish | 2 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.4-T2b |
| Route → Model | an SSRC a re-offer moves to another m-line keeps its current route until $finish | 2 | シーン: "an SSRC a re-offer moves to another m-line keeps its current route until %s"（TICKET 2.19） | 2.1-T3 2.4-2 2.4-T3 |
| Route → Model | an RTX SSRC a re-offer pairs with another media SSRC keeps its current pairing until $finish | 2 | 対象外（相手の SDP の SSRC を書き換える必要がある。同じバグ R3 は CovC [5-13] が検出する） | 2.4-3 2.4-T4 |
| Route | a second simulcast m-line that reuses the RID names routes by MID through $finish | 2 | ケース | 2.4-1 2.4-T5 |
| EV → Model | a pranswer sends with its codec on both sides until $finish | 2 | シーン: "a pranswer sends with its codec on both sides until %s"（TICKET 2.19） | 2.2-1 2.2-8 2.2-9 2.4-4 2.10-2 |
| EV → 削除 | SSRCs only a replaced pranswer announced stop routing at the final answer | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.1-4 2.2-7 2.2-13 2.2-14 2.4-1 2.5-13 2.10-4 |
| EV → 削除 | a first pranswer with other SSRCs leaves the receiver's track to the final answer's SSRC | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.4-T6 2.10-4 |
| EV → 削除 | a transport a no-BUNDLE first pranswer added stays closed after the BUNDLE answer | 1 | 削除（TICKET 2.20: ブラウザや他の実装の入力をあえて作るケース。相互接続は E2E の責務） | 2.2-13 2.10-9 |
| Matrix → Model | transceiver stop rejects its m-line and a later transceiver reuses it | 2 | 固定シーン「a stopped m-line is rejected and a later transceiver reuses it」 | 2.1-T10 |
| Matrix | BUNDLE split, tag change and merge route RTP by MID | 2 | ケース | 2.1-T9 2.5-T1 5-5 |
