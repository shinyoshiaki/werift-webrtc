---
ide:
  viewer: review-document
  version: 1
  title: "ICE interfaceAddresses の bind と advertise の一致"
  dock: right
  baseCommit: 9d3d17fef3411be19753023d306f8e5481851e23
---
# ICE: interfaceAddresses が bind と advertise でずれる問題の修正

## 1. 概要

`iceInterfaceAddresses`（`IceOptions.interfaceAddresses`）で UDP ソケットを 1 つのアドレスに bind しても、SDP に載る host candidate は**列挙された別の LAN アドレス**になることがありました。相手は SDP のアドレス宛てに connectivity check を送るため、VPN / overlay / multi-NIC 環境で意図しない経路になっていました。

今回の修正で、**明示指定したファミリーの host candidate は、実際にソケットが bind したアドレスとポートで advertise** されます。指定アドレスが列挙結果に無くても別アドレスへフォールバックしません。wildcard bind（指定なし）の挙動は変えていません。

- 修正コミット: c5430dd1 (`ICE: iceInterfaceAddresses can bind one address but advertise a different host candidate`)
- その後 develop をマージ済み（HEAD `9d3d17fe`）。競合解消後も両側の変更が残っていることを確認済み
- 公開 API の型は変更なし。振る舞いと JSDoc / 生成ドキュメントのみ変更

## 2. 何が起きていたか（Before / After）

<style>
.ia-cmp { display:flex; gap:12px; flex-wrap:wrap; font-size:13px; color:var(--review-fg); }
.ia-card { flex:1; min-width:260px; padding:10px 14px; border:1px solid var(--review-border); border-radius:6px; background:var(--review-surface); }
.ia-card.before { border-left:4px solid var(--review-danger); }
.ia-card.after { border-left:4px solid var(--review-success); }
.ia-card code { background:transparent; }
.ia-card ol { margin:6px 0 0; padding-left:18px; }
.ia-tag { font-weight:bold; }
</style>

<div class="ia-cmp">
  <div class="ia-card before">
    <div class="ia-tag">Before（バグ）</div>
    <ol>
      <li><code>udp4: "100.64.0.5"</code>（Tailscale 等）を指定</li>
      <li>列挙結果に <code>tun/utun</code> は含まれない → 絞り込み結果が 0 件</li>
      <li><b>全 LAN アドレスへ黙ってフォールバック</b></li>
      <li>各ループで socket は <code>100.64.0.5</code> に bind（アドレス数 N 個ぶん作られる）</li>
      <li>candidate は <code>192.168.x.y:PORT</code> として advertise ✗</li>
    </ol>
  </div>
  <div class="ia-card after">
    <div class="ia-tag">After（修正後）</div>
    <ol>
      <li><code>udp4: "100.64.0.5"</code> を指定</li>
      <li>IPv4 の host アドレスは<b>指定の 1 個だけ</b>（列挙に無くても採用）</li>
      <li>socket を bind し <code>getExtraInfo()</code> で実アドレス・ポートを取得</li>
      <li>candidate = <code>100.64.0.5:PORT</code>、<code>localIp</code> も同じ値 ✓</li>
      <li>bind 失敗時は candidate を出さずエラーログ（別アドレスで代替しない）</li>
    </ol>
  </div>
</div>

## 3. 処理フロー

<svg viewBox="0 0 760 150" width="100%" role="img" aria-label="gatherCandidates の新しいフロー">
  <defs><marker id="ia-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--review-muted)"/></marker></defs>
  <g fill="var(--review-surface)" stroke="var(--review-border)">
    <rect x="4" y="30" width="140" height="56" rx="6"/>
    <rect x="200" y="30" width="150" height="56" rx="6" stroke="var(--review-accent)" stroke-width="2"/>
    <rect x="406" y="30" width="150" height="56" rx="6"/>
    <rect x="612" y="30" width="144" height="56" rx="6" stroke="var(--review-accent)" stroke-width="2"/>
  </g>
  <g stroke="var(--review-muted)" marker-end="url(#ia-arr)">
    <line x1="144" y1="58" x2="198" y2="58"/><line x1="350" y1="58" x2="404" y2="58"/><line x1="556" y1="58" x2="610" y2="58"/>
  </g>
  <g fill="var(--review-fg)" font-size="12" text-anchor="middle">
    <text x="74" y="55">getHostAddresses()</text><text x="74" y="72" fill="var(--review-muted)">NIC 列挙</text>
    <text x="275" y="55">resolveHostAddresses()</text><text x="275" y="72" fill="var(--review-accent)">新規・純関数</text>
    <text x="481" y="55">connectionMade()</text><text x="481" y="72" fill="var(--review-muted)">UDP bind</text>
    <text x="684" y="55">getExtraInfo()</text><text x="684" y="72" fill="var(--review-accent)">実 bind を advertise</text>
  </g>
  <g fill="var(--review-muted)" font-size="11" text-anchor="middle">
    <text x="275" y="115">指定ファミリー → 指定 1 個のみ / 未指定 → 従来どおり</text>
    <text x="620" y="115">指定あり: bound host / 指定なし: 列挙アドレス（0.0.0.0 は出さない）</text>
  </g>
</svg>

## 4. 主要変更

### 4.1 host アドレス決定を純関数に切り出し

[packages/ice/src/internal/resolveHostAddresses.ts:25](review-file:packages/ice/src/internal/resolveHostAddresses.ts:25) が新規。差分は [packages/ice/src/internal/resolveHostAddresses.ts](review-diff:packages/ice/src/internal/resolveHostAddresses.ts) です。`gatherCandidates()` 側の呼び出しは [packages/ice/src/ice.ts:825](review-file:packages/ice/src/ice.ts:825) で、従来の「`Object.values(interfaceAddresses)` で絞り込み、0 件なら全列挙にフォールバック」を置き換えています（[差分](review-diff:packages/ice/src/ice.ts:825)）。

<style>
.ia-tbl { width:100%; border-collapse:collapse; font-size:13px; color:var(--review-fg); }
.ia-tbl th, .ia-tbl td { border:1px solid var(--review-border); padding:6px 10px; text-align:left; vertical-align:top; }
.ia-tbl th { background:var(--review-surface); }
</style>

<table class="ia-tbl">
  <tr><th>入力状態</th><th>返す host アドレス</th></tr>
  <tr><td>どのファミリーも未指定</td><td>列挙 ＋ <code>additionalHostAddresses</code>（従来と同一）</td></tr>
  <tr><td><code>udp4</code> 指定</td><td>IPv4 は <code>udp4</code> 1 個のみ（列挙に無くても採用）。<code>useIpv4=false</code> なら使わない</td></tr>
  <tr><td>片方のみ指定（例 <code>udp4</code>）</td><td>未指定ファミリー(IPv6)の<b>列挙は使わない</b>（従来挙動を維持）。<code>additionalHostAddresses</code> の IPv6 は追加される</td></tr>
  <tr><td>指定ファミリーの <code>additionalHostAddresses</code></td><td>指定と同じなら採用（重複排除）、異なれば debug ログを出して無視</td></tr>
</table>

チケットの「要決定」だった**部分指定時の扱いは、後方互換を優先して「未指定ファミリーは除外」を維持**しました。JSDoc にも明記しています。

### 4.2 UDP host candidate を実 bind アドレスで作る

[packages/ice/src/ice.ts:1104](review-file:packages/ice/src/ice.ts:1104) 付近。`protocol.getExtraInfo()` が返す bind 済みの host / port で candidate を作り、`protocol.localIp` も同じ値にします（[差分](review-diff:packages/ice/src/ice.ts:1104)）。

- 明示 bind あり: bound host を採用（IPv6 zone id は `stripZoneId` で除去）。ループ変数と異なれば debug ログ
- 明示 bind なし: 従来どおり列挙アドレス（`0.0.0.0` / `::` は advertise しない）
- ICE restart 時の重複防止 [packages/ice/src/ice.ts:1052](review-file:packages/ice/src/ice.ts:1052): IPv6 の表記揺れで `localIp` 比較が外れても、指定ファミリーの host UDP が既にあれば再作成しない

### 4.3 bind 失敗の扱い

[packages/ice/src/ice.ts:1145](review-file:packages/ice/src/ice.ts:1145): 明示 bind の失敗は `failed to bind UDP socket to interface address` をログ出力し、そのファミリーの candidate は 0 個になります。別アドレスでの advertise はしません。

あわせて [packages/common/src/transport.ts](review-diff:packages/common/src/transport.ts:commit:c5430dd) で、bind の `error` イベントを `init()` の reject に変換しました。以前は `EADDRNOTAVAIL` が未処理の `error` イベントとなり得たためで、失敗時はソケットも close します。

### 4.4 TCP candidate

追加変更はありません。列挙アドレスが指定の 1 個になるため、TCP passive / active も指定アドレスで bind・advertise され、LAN への漏れも同時に解消します（`TCP host candidates use the interface address` テストで確認）。

### 4.5 ドキュメント

- JSDoc: [packages/ice/src/iceBase.ts:307](review-file:packages/ice/src/iceBase.ts:307)（`interfaceAddresses` / `additionalHostAddresses`）、[packages/webrtc/src/api/peerConfig.ts:67](review-file:packages/webrtc/src/api/peerConfig.ts:67)（`iceInterfaceAddresses`）
- `npm run doc` の生成物: `doc/interfaces/{PeerConfig,IceOptions}.md`、`doc/classes/RTCPeerConnection.md`、`packages/ice/doc/interfaces/IceOptions.md`（develop マージ後に再生成して差分なしを確認）

## 5. 判断理由

- **フォールバック廃止**: 指定が列挙に無い（tun / loopback）ケースこそ指定を正とすべきケースで、黙った代替は経路を誤らせるため
- **bind アドレスを SSOT に**: 相手が check を送る先と、実際に受けるソケットを構造的に一致させる
- **部分指定は除外を維持**: 既存利用者の挙動を変えない。変える場合は別途合意が必要
- **失敗時は candidate なし＋明確なログ**: チケット推奨どおり。`Promise.allSettled` の既存挙動は変えない
- **純関数化**: 実 NIC に依存せず `127.0.0.1` / `::1` でテスト可能（`127.0.0.1` は `internal` のため列挙外のケースをそのまま再現できる）

## 6. 影響範囲とリスク

<table class="ia-tbl">
  <tr><th>観点</th><th>影響</th><th>状態</th></tr>
  <tr><td>wildcard bind（未指定）</td><td>変更なし（テストで列挙ごとの candidate と <code>0.0.0.0</code>/<code>::</code> 非 advertise を確認）</td><td style="color:var(--review-success)">維持</td></tr>
  <tr><td>部分指定（<code>udp4</code> のみ）</td><td>IPv6 列挙は従来どおり除外。<code>additional</code> は適用</td><td style="color:var(--review-success)">維持</td></tr>
  <tr><td>ICE restart</td><td>単一ソケット再利用、重複 socket なし</td><td style="color:var(--review-success)">テストあり</td></tr>
  <tr><td>bind 失敗</td><td>そのファミリーの host candidate が 0 個になる（利用者から見た挙動変更）</td><td style="color:var(--review-warning)">仕様どおり・ログで検知</td></tr>
  <tr><td><code>e2e/server/fixture.ts</code> の <code>iceFilter*</code></td><td>修正後は冗長の見込みだが未変更（残しても無害）</td><td style="color:var(--review-warning)">未検証</td></tr>
  <tr><td>link-local IPv6 の scope ID</td><td><code>%if</code> を除去して advertise。実機での挙動は未確認</td><td style="color:var(--review-warning)">未確認</td></tr>
</table>

## 7. テスト

[packages/ice/tests/ice/interface-addresses.test.ts](review-file:packages/ice/tests/ice/interface-addresses.test.ts) を新規追加（Arrange ヘルパーは [packages/ice/tests/utils.ts](review-file:packages/ice/tests/utils.ts) の `createInterfaceBoundConnection` / `udpHostCandidatesWithBinding`）。

| 完了条件 | テスト |
| --- | --- |
| udp4 明示で bind と candidate が一致 | `udp4 interface address is advertised with the bound address and port` |
| udp6 明示（利用不可なら skip） | `udp6 interface address is advertised ...` |
| 列挙外アドレスでもフォールバックしない・UDP host 1 個 | 上記 udp4 テスト（`127.0.0.1`）／`a failed bind ...` |
| 明示なしは従来どおり | `without interfaceAddresses, every enumerated address gets a host candidate` |
| `portRange` でもポート一致 | `candidate port is the bound port within portRange` |
| 指定 interface のみで 2 Connection が接続 | `two agents connect using only their interface-bound candidates` |
| `additionalHostAddresses` / TCP / bind 失敗 | `additionalHostAddresses other than ...` / `TCP host candidates ...` / `a failed bind ...` |
| ICE restart | `ICE restart keeps the single interface-bound UDP socket` |
| 純関数 | `resolveHostAddresses` の 6 テスト（部分指定、additional 併用、列挙外、無効ファミリー等） |

## 8. 検証結果

最新（develop マージ後）の確認結果です。

<table class="ia-tbl">
  <tr><th>コマンド</th><th>結果</th></tr>
  <tr><td><code>cd packages/ice &amp;&amp; npm run type &amp;&amp; npm test</code></td><td style="color:var(--review-success)">成功（37 ファイル・264 テスト、1 ファイル・5 テスト skip）</td></tr>
  <tr><td><code>npm run type</code></td><td style="color:var(--review-success)">成功</td></tr>
  <tr><td><code>npm run test:small</code></td><td style="color:var(--review-success)">成功（webrtc 872 成功 / 5 skip、rtp 369、sctp 59、import smoke）</td></tr>
  <tr><td><code>npm run doc</code></td><td style="color:var(--review-success)">成功・再生成差分なし</td></tr>
  <tr><td><code>npm run e2e</code> / WPT</td><td style="color:var(--review-warning)">未実施</td></tr>
</table>

上記は前の作業ターンでの実行結果です。この解説ドキュメント作成のターンではテストを再実行していません（コード変更なしのため）。

## 9. 未確認事項

- 全 E2E（`npm run e2e`）と WPT は未実施。`iceLitePeerConfig` が `iceInterfaceAddresses` を使うため、可能なら E2E での確認を推奨
- `e2e/server/fixture.ts` の `iceFilterStunResponse` / `iceFilterCandidatePair` を削除できるかは未判断
- 実 NIC（Tailscale 等）での実機確認は未実施。CI 相当は loopback ベース
- link-local IPv6 を `interfaceAddresses` に指定した場合の実機挙動は未確認
