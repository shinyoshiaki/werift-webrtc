---
ide:
  viewer: review-document
  version: 1
  title: "os.networkInterfaces() 失敗時の candidate gathering（レビュー解説）"
  dock: right
  baseCommit: 0ca2d486d11d8e749e15c1f8f85b5a780c83819c
---
# os.networkInterfaces() 失敗時に candidate gathering を落とさない（レビュー解説）

## 1. 概要

`AF_NETLINK` を禁止した環境（systemd `RestrictAddressFamilies=` など）では、`os.networkInterfaces()` が同期的に `SystemError` を throw します。この変更で、その例外が (1) mDNS 経路ではプロセスを終了させ、(2) host 候補の列挙経路では gathering を中途半端な状態で止める、という 2 つの問題を解消しました。

列挙に失敗しても gathering は続行し、完了させます。失敗は W3C の名前空間の外にある werift 拡張イベント `onGatheringError`（ICE 層）、`RTCIceTransport.onGatheringError`、`RTCPeerConnection.onIceGatheringError` で通知します。`icecandidateerror`、`iceGatheringState` の列挙値、`setLocalDescription` の resolve/reject は変えていません。

比較の起点はチケット worktree の `45d545c73`（develop マージ）で、対象は 3 つのコミットです。変更は 39 ファイル、うち約半分は `npm run doc` の生成物です。

## 2. 修正前の問題と修正後の仕組み

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-family:sans-serif;font-size:13px">
<div style="border:2px solid #d9534f;border-radius:8px;padding:10px">
<b style="color:#d9534f">Before</b>
<ol style="margin:6px 0;padding-left:18px">
<li>[mDNS] リモートの <code>.local</code> 候補で <code>new MdnsLookup()</code></li>
<li><code>multicast-dns</code> が <code>'listening'</code> と 5 秒ごとの <code>setInterval</code> で <code>os.networkInterfaces()</code> を呼ぶ</li>
<li style="color:#d9534f"><b>throw → uncaughtException でプロセス終了</b></li>
<li>[gathering] <code>gatherCandidates()</code> が <code>localCandidatesStart = true</code> にして列挙</li>
<li style="color:#d9534f"><b>throw → Start のまま End が来ない。2 回目の呼び出しは候補 0 個のまま <code>completed</code></b></li>
<li style="color:#d9534f"><b><code>RTCIceGatherer.gather()</code> が reject → <code>gatheringState</code> が <code>gathering</code> のまま。エラーは <code>.catch(log)</code> で消える</b></li>
</ol>
</div>
<div style="border:2px solid #2e9e5b;border-radius:8px;padding:10px">
<b style="color:#2e9e5b">After</b>
<ol style="margin:6px 0;padding-left:18px">
<li>[mDNS] <code>createMulticastDns()</code> が <code>readNetworkInterfaces()</code> で先に列挙</li>
<li style="color:#2e9e5b"><b>失敗 → ソケットを作らず lookup を reject、候補は破棄。<code>update()</code> は try/catch 版に差し替え</b></li>
<li style="color:#2e9e5b"><b><code>'error'</code> / <code>'warning'</code> のリスナーを登録（未処理 error でも落ちない）</b></li>
<li>[gathering] 1 回の <code>readNetworkInterfaces()</code> の結果を host / assigned の両方で共有</li>
<li style="color:#2e9e5b"><b>失敗 → <code>interface-enumeration-failed</code> を通知して続行。explicit / additional / STUN / TURN の候補で完了</b></li>
<li style="color:#2e9e5b"><b>候補 0 個なら <code>no-candidates</code>、想定外の例外なら <code>gathering-failed</code>。いずれも <code>complete</code> と end-of-candidates に到達</b></li>
</ol>
</div>
</div>
<p style="font-family:sans-serif;font-size:12px;color:#666">赤は問題のあった処理、緑は変更後の処理です。mDNS（経路 B）と host 列挙（経路 A）を同じ順序で並べています。</p>

## 3. 主要変更

### ICE 層（`packages/ice`）

- 列挙ヘルパー。[packages/ice/src/internal/hostInterfaces.ts:23](review-diff:packages/ice/src/internal/hostInterfaces.ts:23) に、例外を投げずに `{ interfaces, error? }` を返す `readNetworkInterfaces()` を追加しました。`getHostInterfaceAddresses()` と `getAssignedInterfaceAddresses()` は列挙結果を引数で受け取れるようにし、1 回の gathering で結果が食い違わないようにしています。
- gathering の状態管理。[packages/ice/src/ice.ts:795](review-diff:packages/ice/src/ice.ts:795) の `gatherCandidates()` は、想定外の例外で `gathering-failed` を通知し、世代を終了させたうえで reject します。これで A-1 の「偽の completed」を防ぎます。
- 列挙失敗の扱い。[packages/ice/src/ice.ts:897](review-diff:packages/ice/src/ice.ts:897) で `interface-enumeration-failed` を通知し、空の列挙結果で続行します。`additionalHostAddresses` は assigned が空になるため wildcard bind になります。
- 世代の終了。[packages/ice/src/ice.ts:972](review-diff:packages/ice/src/ice.ts:972) の `endLocalCandidates()` は、候補が 0 個なら `no-candidates` を通知してから End にします。ICE restart で再 advertise された候補は数えます。
- 通知の共通ガード。[packages/ice/src/ice.ts:990](review-diff:packages/ice/src/ice.ts:990) の `emitGatheringError()` は、世代が置き換わった後と close 後には発火しません。listener の throw は隔離して log に記録します。
- 型。[packages/ice/src/gatheringError.ts:1](review-diff:packages/ice/src/gatheringError.ts:1) に `IceGatheringErrorReason`（`as const` と同名 union。`enum` は使っていません）と `IceGatheringErrorInfo` を追加しました。`IceConnection` への追加は optional です（[packages/ice/src/iceBase.ts](review-diff:packages/ice/src/iceBase.ts)）。
- mDNS。[packages/ice/src/dns/lookup.ts:57](review-diff:packages/ice/src/dns/lookup.ts:57) の `createMulticastDns()` が、`multicast-dns` の `update()` を例外を投げない版に差し替えます。最初の列挙が失敗したら throw し、`MdnsLookup` は listen しないダミーソケットに切り替えて lookup を即 reject します。`'error'` と `'warning'` のリスナーも登録しました。`MdnsLookup` の公開形状（`cache`、`mdnsInstance`、constructor の factory 引数）は維持しています（[packages/ice/src/dns/lookup.ts:136](review-diff:packages/ice/src/dns/lookup.ts:136)）。
- 公開 API の契約。[packages/ice/src/utils.ts:41](review-diff:packages/ice/src/utils.ts:41) の `nodeIpAddress()` / `getHostAddresses()` は従来どおり throw し、JSDoc に `@throws` を明記しました。

### webrtc 層（`packages/webrtc`）

- [packages/webrtc/src/transport/ice.ts:1159](review-diff:packages/webrtc/src/transport/ice.ts:1159) の `RTCIceGatherer.gather()` は、`gatherCandidates()` が reject しても `gatheringState` を `complete` まで進め、end-of-candidates を出します。`onGatheringError` を持たない `IceConnection` 実装でも `gathering-failed` が通知されます。reject 自体は呼び出し元へ伝えるので、`setLocalDescription` は reject されません。
- `RTCIceTransport.onGatheringError` を追加しました（[packages/webrtc/src/transport/ice.ts:241](review-diff:packages/webrtc/src/transport/ice.ts:241)）。closed なら転送せず、`close()` で `complete()` します。
- `RTCPeerConnection.onIceGatheringError` を追加しました（[packages/webrtc/src/peerConnection.ts:259](review-diff:packages/webrtc/src/peerConnection.ts:259)）。購読は [packages/webrtc/src/peerConnection.ts:1167](review-diff:packages/webrtc/src/peerConnection.ts:1167) にあり、close 後と rollback で破棄される transport では通知しません。`on<event>` プロパティと `addEventListener` の type は追加していません。

### ドキュメント・テスト

- [changelog.md](review-diff:changelog.md)、[packages/webrtc/README.md](review-diff:packages/webrtc/README.md)、`doc/` と `packages/ice/doc` の再生成（`npm run doc`）。
- 新規テストは Arrange 共通化ユーティリティ付きです。ICE 層の [packages/ice/tests/ice/interface-enumeration.test.ts](review-file:packages/ice/tests/ice/interface-enumeration.test.ts)、mDNS の [packages/ice/tests/ice/mdns-enumeration.test.ts](review-file:packages/ice/tests/ice/mdns-enumeration.test.ts)、webrtc 層の [packages/webrtc/tests/transport/iceGatheringError.test.ts](review-file:packages/webrtc/tests/transport/iceGatheringError.test.ts) です。共通 Arrange は [packages/ice/tests/ice/interfaceEnumerationUtils.ts](review-file:packages/ice/tests/ice/interfaceEnumerationUtils.ts) と [packages/webrtc/tests/transport/iceGatheringErrorUtils.ts](review-file:packages/webrtc/tests/transport/iceGatheringErrorUtils.ts) にあります。

## 4. 判断理由（採用しなかった案）

| 案 | 判断 | 理由 |
| --- | --- | --- |
| 既存の `icecandidateerror`（701）に載せる | 不採用 | W3C では `url` と 701 がサーバー到達性専用です。URL 単位の重複排除に混ざり、WPT 前提の挙動が壊れます。 |
| `setLocalDescription()` を reject させる | 不採用 | W3C では gathering は SLD 後に非同期で進み、その失敗で SLD は reject しません。 |
| `iceGatheringState` に `failed` を追加する | 不採用 | 列挙型を広げると既存の switch が壊れます。 |
| `connectionState` を `failed` にする | 不採用 | 失敗の判断はチェックリストの結果に任せます。 |
| werift 拡張の `Event` を新設する | 採用 | 既存の `onIceCandidateError` / `onIceServerReached` と同じ形で、W3C の名前空間を使いません。 |
| mDNS を `opts.interface` 指定で作る | `update()` を差し替える形に変更 | `opts.interface` は bind アドレスにも使われ、複数 NIC の membership を維持できません。`update()` の差し替えなら従来どおり wildcard bind を保ち、後から現れた NIC も join できます。 |
| 例外後に `localCandidatesStart` を戻して再 gather する | 不採用 | 開いたソケットが advertise 済みのままになるためです。 |

## 5. レビュアーが確認すべき点・リスク

- `createMulticastDns()` は `multicast-dns` の内部 `update` を上書きします（`instance as unknown as { update }`）。`multicast-dns` のバージョンを上げるときは、`update` の内容（`allInterfaces()` / `defaultInterface()` の挙動）との整合性を確認してください。[packages/ice/src/dns/lookup.ts:107](review-file:packages/ice/src/dns/lookup.ts:107)
- 列挙失敗時の `additionalHostAddresses` は assigned 判定ができず、すべて wildcard bind になります。意図した挙動ですが、仕様として確認してください。
- `no-candidates` は列挙失敗だけでなく、あらゆる原因で候補が 0 個のときに出ます。reason の追加は minor で行うため、利用側は未知の値を扱う必要があります（changelog に記載）。
- BUNDLE なしで複数 transport があると、通知は transport ごとに 1 回ずつ届きます。重複排除はしていません。
- mDNS の失敗は `onGatheringError` に載せず、log に記録して該当リモート候補を破棄します（現行の lookup タイムアウトと同じ扱い）。
- 公開 API が増えます（`IceGatheringErrorReason`、`IceGatheringErrorInfo`、`IceGatheringErrorDetails`、`RTCIceGatheringErrorEvent` と 3 つのイベント）。`packages/webrtc/tools/wpt-runner/*` は変更していません。
- `packages/ice-server` の `turnServer.ts` と、列挙以外の rejection の監査（#840）は対象外です。

## 6. 検証結果

この文書の作成時には、テストやビルドを実行していません。以下は、このハンドオフで私が実行した検証ではなく、コミットの差分から確認できた範囲です。

- 差分の確認: `git diff 45d545c73 HEAD`（39 ファイル、+2168 / -122）を読みました。
- 回帰テストの追加: 上記 3 つのテストファイルが追加されています。

チケットの完了条件にある `npm run type`、`npm run test:small`、`npm run wpt`、`npm run format`、`cd packages/ice && npm test`、`cd packages/webrtc && npm test` の結果は、この文書からは確認していません。実機（`systemd-run` の `RestrictAddressFamilies`）での確認も同様です。レビュー前に、これらの実行結果を別途確認してください。
