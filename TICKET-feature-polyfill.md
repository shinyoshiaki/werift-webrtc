チケット統合作業として、指定された `ide-cli` の手順を確認し、親子 ticket file の実内容を照合します。

## 概要

ブラウザ向け WebRTC ライブラリを Node.js 上で利用できるよう、`werift/polyfill` を追加します。`installPolyfill({ mediaRegister })` で WebRTC グローバルと `navigator.mediaDevices` をインストールし、登録したファイル・RTP・エンコード済みメディア・カスタムソースをブラウザ形式の `getUserMedia(constraints)` から取得できるようにします。

比較対象は `develop`（確認時の `origin/develop`: `ab956a64`）です。polyfill 本体に加え、examples の移行と自動テスト、mediasoup 相互接続 fixture、Node.js 対応バージョンと CI の更新を含みます。

## 公開 API とメディアソース

- `werift/polyfill` と `werift/polyfill/dom` に CJS・ESM・型定義のエントリを追加します。グローバルの変更は `installPolyfill` の呼び出し時に行います。
- グローバルの PeerConnection と取得したトラックは werift のクラスを使い、`writeRtp` 等の拡張を利用できます。`RTCSessionDescription` はブラウザ形式の `{ type, sdp }` を受け取ります。
- `mediaRegister` は必須の配列です。空配列でも PeerConnection / DataChannel を利用でき、メディア取得は `NotFoundError` になります。
- `target` でインストール先を指定でき、戻り値の `uninstall()` で元のグローバルとプロパティ定義を復元します。途中でインストールに失敗した場合も変更を巻き戻します。
- 既存の `navigator.mediaDevices` は `existingMediaDevices: "overwrite" | "throw" | "noop"` で扱いを選択できます。既定値は `"overwrite"` です。
- Node.js の User-Agent または未設定の値を Chromium 互換の値で補完し、mediasoup-client の Handler 自動検出に対応します。`userAgent` による明示指定と uninstall 時の復元も提供します。

| Register | 入力と動作 |
| --- | --- |
| `createMp4WebmRegister` | MP4 / WebM の `path`、`binary`、Node / Web Stream を受け取り、取得後に再生します。コンテナから MIME・audio/video の有無・codec を判定し、音声専用ファイルとループ再生にも対応します。 |
| `createRtpRtcpRegister` | UDP または Node / Web Stream から RTP / RTCP mux を受け取り、トラックへ配信します。`mimeType` は必須で、`clockRate` は codec ごとの既定値を利用できます。 |
| `createEncodedBinaryRegister` | UDP または Node / Web Stream からエンコード済みアクセスユニットを受け取り、RTP に packetize します。RTP timestamp は受信間隔と codec の clock rate から生成します。 |
| `createCallbackRegister` / `MediaRegister` | ユーザー定義の `createTracks(request)` でトラックを生成し、ビルトインと同じ取得経路で利用できます。 |

RTP / encoded binary の Stream 入力は 4 byte big-endian の長さプレフィックスを使います。UDP は 1 datagram を 1 パケットまたは 1 アクセスユニットとして扱います。ファイルの読み込みや UDP bind などの I/O は、インストール後の準備・取得処理で開始します。

各 register に任意の `deviceId`・`groupId`・`label` を設定でき、省略された `deviceId` は一意に採番します。重複した明示 ID はインストール時に拒否し、`enumerateDevices()` で登録したデバイスを列挙します。

`getUserMedia` のデバイス選択には `deviceId`・`groupId`・werift 拡張の `mimeType` を使います。必須制約、ideal、optional な `advanced` を扱い、同じ優先度なら登録順で選択します。要求が空なら `TypeError`、対象 kind がなければ `NotFoundError`、必須制約が不一致なら `OverconstrainedError` を返します。I/O 失敗や取得中断は `NotReadableError` / `AbortError` として通知します。

**カスタム register の `createTracks` には、`kind`・選択した `deviceId`・`constraints`・中断用 `signal` を渡します。** `width`・`height`・`frameRate`・`facingMode`・`advanced` などの生成用制約を保持し、`video: true` / `audio: true` は `{}` に正規化します。解像度等の適用は register 側が担当し、満たせない場合は `OverconstrainedError` を返せます。

## トラック・送信処理と型定義

- `MediaStreamTrack.readyState` / `clone()` と、`MediaStream.getTrackById()` / `active` / `clone()` を追加します。clone は別の ID と停止状態を持ち、共有ソースから RTP / RTCP を受け取ります。RTP パケットは配信先ごとに複製します。
- 複数回のメディア取得、clone、EOF、取得失敗、uninstall に伴う停止処理を整備します。register ごとに入力とトラックを管理し、取得途中の中断や Web Stream の cancel・ロック解放に対応します。
- register 由来のトラックの codec を PeerConnection の offer / answer に反映します。MP4 / WebM は mediabunny による検出と検出結果に整合する明示設定を扱い、callback register は `mimeType` から codec を補完します。
- PeerConnection と RTCRtpSender に `pendingRtp` を追加します。既定は無効で、`true` または `{ maxLength }` で有効化できます。DTLS 接続と codec 設定を待つキューの既定上限は 256 パケットで、超過時は古いパケットから破棄します。送信順序と各 `sendRtp()` の Promise を管理し、送信失敗・停止・キュー破棄でも未完了のまま残さないようにします。
- DOM なしの TypeScript では `werift/polyfill` が werift のグローバル型を提供します。`lib.dom` を含む場合は `werift/polyfill/dom` を使い、DOM コンストラクタ型との衝突を避けながら `writeRtp` などの拡張を利用できます。
- MP4 出力の負の timestamp をトラックごとに補正し、終了時の非同期エラー処理を調整します。WebM 録画では `video/AV1` と従来の `video/AV1X` を扱います。

## examples・相互接続・CI

- sendonly・RTP 取り込み等の examples とファイル再生テストを、`installPolyfill` + register + `getUserMedia` に移行します。README、日英サイトドキュメント、生成 API ドキュメント、changelog も更新します。
- `examples/e2e` に Vitest + Playwright Chromium の smoke test を追加します。DataChannel、ICE、メディア送受信、録画、ffmpeg / GStreamer を使うサンプルを検証し、対象外のサンプルを `examples/untested` に移動します。
- examples のブラウザ用依存を `examples/e2e/vendor` に同梱し、CI 実行中の CDN ダウンロードを不要にします。プロセス終了と録画出力の検証も追加します。
- `integration/werift-mediasoup-interop` を submodule として追加します。現在の参照 SHA は `8083987ff1a5aa207361202401a55cc2fb5a34ec` です。実 mediasoup worker と werift、さらにネイティブ WebRTC を使う Chromium の間で、Handler 自動検出、音声・映像の双方向 RTP、DataChannel、同時接続、終了処理を検証します。
- WPT sandbox のグローバル注入と dummy media を公開 polyfill に統一します。WPT 固有の strict PeerConnection ラッパは runner 内に置き、linked worktree で WPT の作業ディレクトリが空になる場合の checkout 復旧も追加します。
- GitHub Actions の実行環境を Node.js 24 に統一し、既存 CI に examples E2E と mediasoup 相互接続ジョブを追加します。

## 破壊的変更と移行方法

- `werift/nonstandard` の `getUserMedia({ path | buffer | stream })` を公開 API から削除します。`createMp4WebmRegister` にソースを登録し、`navigator.mediaDevices.getUserMedia()` で `MediaStream` を取得してください。旧 `buffer` 入力は register の `binary` に対応します。
- リポジトリと各プロトコルパッケージの Node.js 最小バージョンを **22** に揃えます。CI で検証するバージョンは **24** です。実行対象は Linux / macOS 等の Unix 環境です。

音声・映像を含むファイルの移行例:

```ts
import {
  createMp4WebmRegister,
  installPolyfill,
} from "werift/polyfill";

const uninstall = installPolyfill({
  mediaRegister: [
    createMp4WebmRegister({ path: "./clip.mp4", deviceId: "clip" }),
  ],
});

const stream = await navigator.mediaDevices.getUserMedia({
  audio: { deviceId: { exact: "clip" } },
  video: { deviceId: { exact: "clip" } },
});

// stream のトラックを PeerConnection に追加して利用する。
// 利用終了時に呼び出す。
uninstall();
```

OS のカメラ・マイクの取得や、ビルトイン register による解像度変更・再エンコードは提供しません。メディア生成と制約の適用が必要な場合はカスタム register で実装します。

## テスト

追加・更新したテストと実行コマンドは次のとおりです。

| 対象 | 検証内容・コマンド |
| --- | --- |
| polyfill / WebRTC | インストールと復元、デバイス選択、例外、各入力形式、音声専用ファイル、複数取得・clone・中断、codec 反映、pending RTP を検証します。`npm test --workspace packages/webrtc` |
| カスタム register | `polyfill.test.ts` で `width: 1280` / `height: 720` / `frameRate: 30` / `facingMode: "user"` の受け渡しと、`video: true` → `{}` を検証します。 |
| 型・import | DOM あり / なしのコンパイルテストと `werift-dev/polyfill` の import smoke を追加します。`npm run type`、`npm test --workspace import-test` |
| MP4 | timestamp 補正と終了処理の回帰テストを追加します。`npm test --workspace packages/rtp` |
| WPT | 共通インストーラー経由の allowlist と checkout 復旧を検証します。`npm run wpt --workspace packages/webrtc` |
| examples | Chromium と ffmpeg / GStreamer を使う smoke test を実行します。`npm run examples:e2e` |
| mediasoup | fixture 内の `npm run type`、`npm run test:small`、`npm run test:interop`、`npm run install:browsers`、`npm run test:browser` で検証します。 |

WPT / mediasoup fixture の準備には `git submodule update --init --recursive` を使用します。mediasoup の `test:small` は worker を起動せず、`npm test` は small + 実 worker の interop、Chromium を含む試験は `test:browser` で実行します。ブラウザ相互接続は RTP ヘッダと受信パケット数で到達を検証し、映像の画質評価は対象に含めません。