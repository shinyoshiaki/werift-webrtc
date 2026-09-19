# Issue #705: media section の reject と removeTrack 後の再交渉

`removeTrack.test.ts` の受信確認先が `index: 1` から `index: 3` に変わったのは、inactive な media section を誤って reject していた処理を修正したためである。2 本目は同じ MID のまま残り、ブラウザが新しく追加した transceiver は 4 本目の m-line に対応する。

本書は 2026-09-19 時点の `develop`（`62582c21`）を「以前」、作業ブランチの `83ab91e9` を「現在」として比較する。対象は [チケット #705](../../TICKET-ticket-4502cb15-1c26-483f-9742-2294e86e343e.md) と [removeTrack E2E](../../e2e/tests/mediachannel/removeTrack.test.ts) に関係する SDP・transceiver の挙動であり、WebRTC 全体への完全準拠を示すものではない。

追補では、`1cc2a64c` の werift と、調査時点のブラウザ・SDK の公開ソースを確認した。**inactive のまま新規 transceiver を追加し続ければ SDP は大きくなる。ただし、既存 transceiver の再開には port 0 は不要である。** 「同じ transceiver の再使用」と「停止済み m-line の位置を別 transceiver に割り当てること」を分けて設計する必要がある。

## 仕様が区別する状態

media section は `m=` 行から始まる SDP の単位、MID はその識別子、m-line index は SDP 内の 0 始まりの位置である。MID と index は別の値であり、再利用された位置に新しい MID が付く場合もある。

| 状態 | SDP 上の意味 | 今回の扱い |
| --- | --- | --- |
| `a=inactive` | RTP の送受信を行わない方向指定 | 受諾した section は非ゼロ port と MID を維持する |
| reject | section を受け入れない | answer の port を `0` にする |
| `transceiver.stop()` | API 上の transceiver 停止 | `removeTrack()` や codec 不一致の内部フラグと区別する |

[RFC 3264 §5.1 / §6.1](https://www.rfc-editor.org/rfc/rfc3264.html#section-5.1) は inactive を方向指定として扱う。inactive でも RTCP は継続する一方、port 0 による stream の削除では RTP/RTCP とも停止する（[§8.2](https://www.rfc-editor.org/rfc/rfc3264.html#section-8.2)）。したがって「RTP を送らないから port 0」とはできない。

API の根拠は RFC だけでなく [W3C WebRTC の removeTrack 手順](https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-removetrack) にある。sender の track を外し、sendonly は inactive、sendrecv は recvonly に変更する。transceiver 自体を stop する操作ではない。[addTransceiver](https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-addtransceiver) は新しい transceiver を作成するが、その transceiver に新しい SDP の位置を割り当てるか、拒否済みの位置を割り当てるかは別の処理である。

チケットが参照する [RFC 8829 §5.2.2](https://www.rfc-editor.org/rfc/rfc8829.html#section-5.2.2) は、追加 transceiver があり、現在の local/remote description に port 0 の section がある場合、その位置を新しい MID で再利用する手順を規定する。inactive で受諾中の section は、この再利用条件を満たさない。RFC 8829 は現在 [RFC 9429](https://www.rfc-editor.org/info/rfc9429/) に置き換えられているため、チケットの参照版と現行版は区別して読む。

## removeTrack テストの以前と現在

このケースではブラウザが offerer、werift が answerer である。ブラウザは同じ video track を用いて sendonly transceiver を 3 本交渉し、2 本目の sender に `removeTrack()` を呼ぶ。その後、新しく `addTransceiver(video, { direction: "sendonly" })` を呼ぶ。

| 段階 | 以前 | 現在 |
| --- | --- | --- |
| 3 本の交渉完了 | index 0・1・2 が存在 | 同左 |
| 2 本目を removeTrack | ブラウザは inactive の offer を生成 | 同左 |
| werift の answer | inactive を理由に index 1 の port を `0` にした | index 1 は inactive・非ゼロ port のまま |
| ブラウザへの意味 | 2 本目が拒否された | 2 本目は受諾済みで送受信を休止 |
| 新しい transceiver の offer | port 0 の index 1 は再利用対象になる | index 1 を維持し、index 3 を追加 |
| E2E の受信確認先 | `index: 1` を期待していた | `index: 3` で RTP 受信を確認 |

以前の因果関係は、旧コードの port 0 生成、旧テストの index 1 の期待値、および JSEP の再利用規定から説明できる。今回のドキュメント作成では、旧版を起動したブラウザ通信の再採取は行っていない。

以下は説明用に MID を `v0`〜`v3` とした SDP 抜粋である。実際の MID の文字列はブラウザが決める。ICE・DTLS・codec 属性などは省略しており、このまま入力できる完全な SDP ではない。`9` はこの実装が使用する discard port で、実際のメディア送信先は ICE で決まる。

```sdp
# 現在: removeTrack 後の answer（抜粋）
a=group:BUNDLE v0 v1 v2
m=video 9 UDP/TLS/RTP/SAVPF 96
a=mid:v0
a=recvonly
m=video 9 UDP/TLS/RTP/SAVPF 96
a=mid:v1
a=inactive
m=video 9 UDP/TLS/RTP/SAVPF 96
a=mid:v2
a=recvonly
```

以前は `v1` の `m=` 行が `m=video 0 ...` になった。現在は非ゼロなので、続くブラウザの新規 transceiver 追加後の offer は次の配置になる。

```text
index   MID   ブラウザの offer の方向
0       v0    sendonly
1       v1    inactive  ← 既存 section を維持
2       v2    sendonly
3       v3    sendonly  ← 新規 transceiver
```

したがって index 3 の検証は、inactive と reject の区別を回復した結果を確認するものとなる。単に `addTransceiver()` は常に m-line を末尾に追加する、と一般化するのは誤りである。

## inactive はいつ port 0 になるか

inactive の継続時間、track の不在、RTP の無通信、m-line の本数を理由に、自動的に port 0 にする仕様はない。`MediaStreamTrack.stop()` も `RTCRtpTransceiver.stop()` とは別である。

| 操作・条件 | 非ゼロ port の inactive section への結果 |
| --- | --- |
| `direction = "inactive"`、`removeTrack()`、`replaceTrack(null)` | これらだけでは section を拒否しない。`replaceTrack(null)` 単独では direction も変更しない |
| アプリが既存 transceiver に `stop()` を呼び、自分から次の offer を生成 | 対応する section を port 0 で提示し、offer/answer で停止を交渉する |
| 相手から section の削除を表す port 0 の offer を受信 | answer も port 0 を維持する（bundle-only の例外は後述） |
| 相手が対応する answer section を reject | answer の port 0 により拒否が確定する。共通 codec がない場合などが該当 |
| `pc.close()` | 接続全体の終了。再利用用の port 0 SDP を交渉する操作ではない |

根拠は [RFC 3264 §8.2](https://www.rfc-editor.org/rfc/rfc3264.html#section-8.2)、[RFC 9429 §5.2.2 / §5.3.1](https://www.rfc-editor.org/info/rfc9429/#section-5.2.2)、[W3C transceiver.stop](https://www.w3.org/TR/webrtc/#dom-rtcrtptransceiver-stop) である。`stop()` は既存の SDP 文字列を即座に書き換えるのではなく、次の交渉に反映される。W3C は stopping と stopped を区別し、stopping は `createOffer()` では停止扱いにするが、まだ stopped でない段階の `createAnswer()` に同じ扱いを適用しない。answerer が永久停止したい場合も、自分から交渉を開始する手順が必要となる。

停止済みの位置を新しい transceiver に回す際は、旧 transceiver を復活させるのではない。同じ m-line index に新しい MID を割り当てる。[RFC 9429 §5.2.2](https://www.rfc-editor.org/info/rfc9429/#section-5.2.2) の対象は current local/remote description の拒否済み section であり、`stop()` の直後、まだ拒否を交渉していない時点で新規追加しても、同じ offer 内で再利用されるとは限らない。

## SDP の増加を抑える三つの方法

### 1. 既存の transceiver を明示的に再開する

カメラ、画面共有などの用途ごとに transceiver を保持し、一時停止・再開・映像ソース切り替えには同じ sender を使う。以前に送信した transceiver でも、停止されていなければアプリが明示的に再使用できる。MID と m-line の位置を維持するため、追加の section は不要となる。

```js
// ブラウザ API の概念例。negotiate() は offer/answer を完了するアプリ側の処理。
// slot は以前 sendonly で交渉済みの video transceiver。
pc.removeTrack(slot.sender);
await negotiate(); // slot は inactive のまま保持される

await slot.sender.replaceTrack(nextVideoTrack);
slot.direction = "sendonly";
await negotiate(); // 同じ MID の送信を再開する
```

`replaceTrack()` は同じ media kind が必要で、既存の交渉条件に収まらない交換は失敗し得る。direction の変更には再交渉が必要であり、inactive のまま track だけ戻しても送信は再開しない。また相手の direction が受信を許す必要がある。仕様にも direction と replaceTrack を組み合わせた [hold / resume の例](https://www.w3.org/TR/webrtc/#hold-functionality) がある。

一時的に送信ソースだけ外したい場合は `replaceTrack(null)` と同じ sender への `replaceTrack(track)` という選択肢もある。この場合、送信可能な交渉方向を維持していれば direction 変更の交渉は不要だが、相手へ inactive を通知する方法とは異なる。

### 2. addTrack の限定的な自動再使用を利用する

[W3C addTrack](https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-addtrack) の既存 sender 選択には、track が null、media kind が一致、transceiver が stopping でないことに加え、**currentDirection が過去に一度も sendonly/sendrecv になっていない**という条件がある。「実際に RTP パケットを送ったか」ではなく、交渉された方向の履歴による条件である。

そのため、未送信の inactive/recvonly 枠なら自動再使用の候補になるが、一度送信を交渉した枠を removeTrack しただけでは候補に戻らない。後者のケースで `addTrack()` を反復すると新規枠が増え得る。任意の inactive 枠を使いたい場合は、方法 1 のように保存した sender/transceiver を明示的に選ぶ。

### 3. 不要な transceiver を永久停止し、拒否済みの位置を再利用する

```js
// ブラウザ API の概念例。いったん停止の交渉を完了させる。
slot.stop();
await negotiate(); // current SDP に旧 MID の port 0 が反映される

const replacement = pc.addTransceiver(nextVideoTrack, { direction: "sendonly" });
await negotiate(); // 再利用可能な位置があれば、新しい MID で使われる
```

この方法は旧 transceiver の不可逆な停止を伴う。再利用可能な位置がなければ追加されるため、並行して追加・停止を行う場合も本数が必ず一定になるとは限らない。SDP の m-line を単に削除・詰め直すこともできない（[RFC 3264 §8](https://www.rfc-editor.org/rfc/rfc3264.html#section-8)）。再利用は増加を抑える手段であり、過去に拡大した SDP の本数を縮める保証ではない。

## 公開実装で確認できる運用

以下は調査時点の公開ソースに基づく。main/v3 ブランチへのリンクは更新され得る。全製品・全リリースの挙動を代表するものではない。

| 実装 | 確認した処理 | 肥大化対策としての意味 |
| --- | --- | --- |
| Chromium の基盤 libwebrtc | `FindFirstTransceiverForAddedTrack()` が sender の track・kind・停止状態・送信履歴を調べる | inactive を無条件に addTrack の再使用候補にはしない |
| libwebrtc の offer 生成 | current description の rejected 状態などから再利用可能 index をキューに入れ、新規 transceiver に優先割り当て。新 MID を生成 | 拒否済みの位置を消費してから末尾に追加する |
| Firefox の JSEP | disabled answer の適用時に停止・関連付け解除・`SetCanRecycleMyMsection()`。次の `GetTransceiverForLocal()` で未関連付けの RTP transceiver に同じ level を割り当てる | inactive の存在だけではなく、交渉済みの拒否状態で再利用を管理する |

参照: libwebrtc [rtp_transmission_manager.cc](https://webrtc.googlesource.com/src/+/refs/heads/main/pc/rtp_transmission_manager.cc)、[sdp_offer_answer.cc](https://webrtc.googlesource.com/src/+/refs/heads/main/pc/sdp_offer_answer.cc)、Firefox [JsepSessionImpl.cpp](https://github.com/mozilla-firefox/firefox/blob/main/dom/media/webrtc/jsep/JsepSessionImpl.cpp)。Firefox の当該ローカル再利用経路は同じ media type の候補を探す。libwebrtc と Firefox の全境界条件が同一である、という意味ではない。

アプリ側の具体例として、mediasoup-client の [Chrome111 handler](https://github.com/versatica/mediasoup-client/blob/v3/src/handlers/Chrome111.ts) は pause/resume と stop を分けている。`pauseSending()` は保存済み transceiver を inactive にし、`resumeSending()` は同じものを sendonly に戻す。`stopSending()` は media section を close できた場合に transceiver.stop を呼び、交渉を完了する。

同 SDK の [RemoteSdp](https://github.com/versatica/mediasoup-client/blob/v3/src/handlers/sdp/RemoteSdp.ts) は、次回追加時に closed section を優先して選ぶ。ただし最初の BUNDLE section は transport の扱いを考慮して close せず disable に留める実装である。また受信側の再利用では Firefox との互換性を考慮して同じ kind を選ぶ。実運用では、単純な「inactive はすべて port 0 にする」規則ではなく、pause/resume、close/recycle、BUNDLE 維持を分けている。

## Chromium での追加観測

追補作成時、インストール済み Chromium **151.0.7922.34** を Playwright から起動し、ブラウザ内の二つの RTCPeerConnection 間で各段階の offer/answer を適用した。初期配置は audio の index 0 と、対象 video の index 1（MID `1`）。各ケースは独立した接続を使用した。

| video に対する操作 | 観測された結果 |
| --- | --- |
| removeTrack → 交渉 → 新規 addTransceiver → 交渉 | 元の MID `1` は port 9 / inactive、新規 MID `2` を末尾に追加。本数 2 → 3 |
| removeTrack → 交渉 → 同じ sender の replaceTrack + sendonly → 交渉 | MID `1` のまま port 9 / sendonly。本数 2 のまま |
| 送信交渉済みの sender を removeTrack → 交渉 → addTrack → 交渉 | sender の自動再使用なし。MID `2` を追加し、本数 2 → 3 |
| removeTrack → 交渉 → stop → 交渉 → 新規 addTransceiver → 交渉 | MID `1` が port 9 / inactive → port 0。その後同じ index 1 が MID `2` / port 9 に変わり、本数 2 のまま |
| 最初から未送信の inactive video を交渉 → addTrack → 交渉 | 既存 sender を再使用し、MID `1` のまま sendonly。本数 2 のまま |

観測には canvas の video track を用いた。ICE 接続成立や RTP 到達は待たず、SDP・MID・本数と sender の同一性を確認したもので、メディア疎通の試験ではない。Firefox と mediasoup-client はソース調査のみで、今回実行していない。使用した Chromium は環境に存在したビルドであり、市場の安定版のバージョンを意味しない。

## 追加実装: モード選択と stop による再利用

追加要件への対応で `PeerConfig.mLineReuse` を導入した。前回調査時の `1cc2a64c` では stop が未完成だったが、以下の停止・再利用処理を追加している。

```ts
const compatible = new RTCPeerConnection({ mLineReuse: "compatible" }); // 既定
const aggressive = new RTCPeerConnection({ mLineReuse: "aggressive" });
```

| モード | inactive の SDP | 新しい transceiver に既存位置を割り当てる条件 |
| --- | --- | --- |
| `compatible` | 非ゼロ port を維持 | 明示的な stop または remote port 0 による停止の拒否交渉が完了した枠 |
| `aggressive` | 従来どおり port 0 を生成 | inactive を含め、停止・拒否の交渉が完了した枠 |

モードは生成時に選び、`setConfiguration()` での変更は拒否する。積極モードは一時停止を永久拒否として扱う従来の wire 挙動を選ぶものであり、仕様準拠の hold 操作とは異なる。拒否後は旧 transceiver の再開を前提にせず、新しい transceiver を追加する。codec 不一致の拒否、有効な format、BUNDLE からの除外、candidate の MID/index 対応は両モードで維持する。

互換モードでは `addTransceiver()` が既存 inactive transceiver を置き換える旧内部処理も使わない。`addTrack()` の候補からは停止中・拒否済み・送信交渉履歴のある sender を除外する。codec 不一致によるローカルの `rejected` 表現と、stop による永久停止は分けており、この追加は全 reject ケースの JSEP 状態機械を作り直すものではない。

### removeTrack と stop をまとめても本数は維持される

**`removeTrack → stop → 交渉 → 新規 addTransceiver → 交渉` でも、元が2本なら2本のままである。** removeTrack と stop の間の交渉は不要である。ただし stop の拒否交渉を完了してから新規 transceiver を追加することが条件となる。

```ts
pc.removeTrack(second.sender);
second.stop();
await negotiate(); // ここで2本目が port 0 になる

const next = pc.addTransceiver(video, { direction: "sendonly" });
await negotiate(); // 同じ index に新しい MID。本数は2本のまま
```

Chromium 151.0.7922.34 同士でも、この短縮手順により index 1 / MID `1` が port 0 になり、その後 index 1 / MID `2` / port 9 に置き換わることを確認した。さらにブラウザと werift の間で、ブラウザ側 stop と werift 側 stop の両方を検証している。実行範囲は末尾の検証記録を参照。

stop は sender/receiver のメディア処理と router 登録を止め、交渉を要求する。共有 ICE/DTLS transport は残す。次の local offer は port 0 を生成し、answer が適用されると stopped が確定する。新しい offer の生成時に交渉済みの位置を再利用し、旧 transceiver の MID/index を外して新しい MID を割り当てる。SDP に関連付けられる前の stop は m-line を追加しない。

stop の交渉前に新規追加した場合は、停止予定の枠を先取りせず新しい位置へ追加する。また互換モードで answerer が stop を呼んだだけの段階では、生成 answer の port を強制的に 0 にせず、自分からの次の offer で停止を交渉する。

## Issue #705 の変更との関係

[RFC 3264 §6 / §6.1](https://www.rfc-editor.org/rfc/rfc3264.html#section-6) は、共通 format のない stream を port 0 で拒否し、offer の format を少なくとも 1 つ残すことを求める。answer は offer と対応する数・順序の m-line を持つ。[RFC 8829 §5.3.1](https://www.rfc-editor.org/rfc/rfc8829.html#section-5.3.1) も answer 生成時の拒否と、対応する proto・MID の扱いを規定している。

この要件を実装するには、方向とは別の拒否状態が必要だった。現在は `RTCRtpTransceiver.rejected` を使い、共通 codec がない場合や remote port が 0 の場合に設定する。方向が inactive であること自体は拒否理由にしない。

| 処理 | 以前 | 現在 |
| --- | --- | --- |
| 共通 codec がない offer | `setRemoteRTP()` が例外を投げ、SRD が中断 | MID/index を保持して後続 section の処理を続け、answer で拒否 |
| 拒否した answer の形式 | codec 不一致では answer 生成まで到達しない | port 0、offer の位置・MID・type/proto・format を保持 |
| inactive の port | `addTransportDescription()` が 0 に変更 | 方向だけでは 0 にしない |
| remote port 0 + 共通 codec | 拒否状態を独立して保持せず、再受諾する余地があった | 拒否を保持し、pipeline の準備を行わない |
| 再交渉で codec 不一致 | 例外となり、以前の pipeline の拒否処理がない | receiver の router 登録解除、sender/receiver の状態・RTCP・NACK・TWCC を解除 |
| BUNDLE group | 全 media の MID を追加 | port 0 の section を除外し、残りがなければ group を省略 |
| local trickle candidate | bundled 時は index 0 が前提 | local SDP の BUNDLE tag の MID/index を使用 |
| remote offer に新規 m-line | inactive transceiver を置換して既存 MID を失う可能性 | remote description 適用時はその再利用経路を使わない |

実装参照: [SDPManager](../../packages/webrtc/src/sdpManager.ts)、[TransceiverManager](../../packages/webrtc/src/transceiverManager.ts)、[PeerConnection](../../packages/webrtc/src/peerConnection.ts)、[SecureTransportManager](../../packages/webrtc/src/secureTransportManager.ts)。pipeline の解除は [sender](../../packages/webrtc/src/media/rtpSender.ts) の `clearSend()` と [receiver](../../packages/webrtc/src/media/rtpReceiver.ts) の `clearReceive()` に実装されている。共有 ICE/DTLS transport 自体の破棄とは別の操作である。

## BUNDLE の仕様と適用範囲

[RFC 8843 §7.3.1](https://www.rfc-editor.org/rfc/rfc8843.html#section-7.3.1) は、初回 BUNDLE 交渉で先頭の候補を受諾できない場合、offer の BUNDLE リスト順に次の候補を調べる手順を定める。[§7.3.3](https://www.rfc-editor.org/rfc/rfc8843.html#section-7.3.3) では、拒否した section の MID を BUNDLE リストに含めない。チケット内の §7.3.4 は具体例であり、拒否の規定そのものは §7.3.3 にある。

今回の「先頭 video は非対応、後続 audio は対応」という初回交渉では、video の m-line を残して port 0 にし、audio の MID を BUNDLE の先頭にする。local candidate も audio の index に対応させる。一方、remote candidate の MID/index の解決には remote SDP を使うので、拒否した section を配列から削除してはならない。

仕様と現在の実装の範囲には次の区別が必要である。

- RFC 8843 の port 0 は、`a=bundle-only` を伴う場合には単純な reject と同義ではない。現在の `setRemoteRTP()` は port 0 を直接 reject 判定に使うため、その組み合わせへの一般的な準拠を本修正だけで保証できない。
- 初回 BUNDLE の tag 選択と、既に交渉済みの BUNDLE の tag 変更には異なる制約がある。現在の `appendBundleGroup()` は非ゼロ port の media を SDP 順に並べる実装であり、任意の offer の BUNDLE リスト順や交渉済み group の全状態を再現するものではない。
- ブラウザの `addTransceiver()` の説明を、そのまま werift の全ローカル API に適用することはできない。追加実装後は、互換モードで inactive を保持し、停止交渉が完了した位置を再利用する。積極モードでは inactive を port 0 にする従来の wire 挙動を選べる。JSEP の全 reject ケースの状態管理を網羅するものではない。

これらは仕様とコードを読み比べた際の適用範囲の説明であり、今回の追加要件で実装した範囲とは分けて扱う。

## 検証との対応

[removeTrack E2E](../../e2e/tests/mediachannel/removeTrack.test.ts) の `mediachannel_offer_replace_second` は、removeTrack 後と新規追加後の offer/answer の両方で、2 本目の MID・inactive・非ゼロ port・BUNDLE 所属を検証する。加えて 4 本の transceiver、新規 MID、交渉後の sendonly、werift 側 index 3 での実 RTP 受信を確認する。

[705 回帰テスト](../../packages/webrtc/tests/issue/705.test.ts) は codec 不一致、remote port 0、BUNDLE、candidate 対応、再交渉と pipeline 解除を検証する。

2026-09-18 のテスト補強時（`317cc4f2`）の実行結果は、Chromium 140 の removeTrack E2E がリトライなしで 3 件成功、webrtc 全体が 305 passed / 3 skipped、webrtc と E2E の型チェックおよび E2E ビルドが成功だった。これはその時点の記録であり、現在の HEAD に対する再実行結果ではない。初版の文書作成ではソースと仕様の照合、相対リンクの確認、`git diff --check` のみを行った。今回の追補では上記 Chromium の5ケースを追加観測し、パッケージテストは再実行していない。旧版の実ブラウザ再現、Firefox/Safari の実行、WPT、全体 CI は本追補の検証根拠に含めない。


追加実装の検証では、`705-reuse.test.ts` の11件、webrtc 全体の318 passed / 3 skipped、workspace の `npm run type` と `npm run test:small`（import-test を含む）が成功した。E2E の型チェック・ビルドと、Chromium ↔ werift の removeTrack 7件（リトライなし）も成功した。E2E は compatible / aggressive、ブラウザ stop、werift stop を含み、再利用した MID/index の実 RTP 受信まで確認した。WPT、Firefox/Safari、E2E 全件、全体 CI は追加実装でも未実施である。
