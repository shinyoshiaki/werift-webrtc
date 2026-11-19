## 背景
下流の ds-harness-remote で TURN TCP タイムアウト時の未処理 rejection によるプロセス終了が報告されています。ただし、下流のライフサイクル管理に起因する可能性があり、現行 werift での再現は未確認です。

参考: https://github.com/liguobao/ds-harness-remote/issues/241
関連する既存Issue（UDPソケットのエラー）: https://github.com/shinyoshiaki/werift-webrtc/issues/749

## 提案
- ICE/TURN TCP 接続拒否、タイムアウト、RST、接続中の close、close 後の遅延応答を対象に Promise rejection の伝播経路を監査する。
- イベント通知、接続失敗状態、非同期タスクの終了が二重通知・未処理 rejection・ハングを生まないことを確認する。
- 呼び出し側が捕捉可能なエラーとして公開し、不要なバックグラウンドタスクを停止する。
- #749 と重複する UDP socket error の修正は本Issueで重複実装しない。

## 完了条件
- 故障注入テストで unhandledRejection/uncaughtException が発生しない。
- close と接続失敗の競合でも処理が確実に完了する。
- 現行版で再現しなければ調査結果を記録して終了する。

※ 下流の問題が werift 本体に残存するとは未確定です。