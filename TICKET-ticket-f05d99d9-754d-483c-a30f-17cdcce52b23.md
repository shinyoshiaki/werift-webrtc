## 1. タスクの目的と背景

- 親チケットで必要だったコア機能は、すでに `examples/turn-loopback` にあります。  
  - HTTPS `POST /session` / `PUT /session`
  - server-offer / client-answer
  - DataChannel echo
  - HTTPS と TURN/TLS の同一ポート多重化
  - クライアント SPA  
  (`examples/turn-loopback/server/main.ts`, `examples/turn-loopback/src/App.tsx`)

- `packages/ice-server` 側も、外部 TLS listener から TURN へソケットを渡す仕組みがすでにあります。  
  (`packages/ice-server/src/node/turnServer.ts:31-49,172-183`)

- ただし現状の Docker 配布は**ローカル確認用**です。  
  - `examples/turn-loopback/Dockerfile` は Node イメージで `npm run server` を起動するだけ
  - `EXPOSE` は `8443` のみ
  - README も `docker run -p 8443:8443` 前提  
  (`examples/turn-loopback/Dockerfile:1-20`, `examples/turn-loopback/README.md:52-63`)

- 今回の前提では、以下は `examples/turn-loopback/server/main.ts` に持たせず、**同一コンテナ内の別アプリケーション**で担当します。  
  - 平文 HTTP `:8080`
  - `/.well-known/acme-challenge/*` の静的配信
  - `/health`
  - HTTP → HTTPS redirect

- そのためこのタスクの目的は、既存 example を  
  **「Node 単体で 8443 を直接公開する開発用コンテナ」**から  
  **「werift 本体に加えて HTTP/ACME 用の別アプリケーションも同梱し、起動時にコンテナ内だけで証明書セットアップまで完結できるイメージ」**へ拡張することです。  
  永続 volume は前提にせず、コンテナ起動ごとに必要なセットアップをやり直す構成を対象にします。

## 2. 実装すべき具体的な機能や変更内容

| 領域 | 現状 | 今回必要 |
| --- | --- | --- |
| Dockerfile | 単一 Node 実行、8443 のみ公開 | werift 本体 + HTTP/ACME 用アプリを同梱し、起動スクリプトで両者を立ち上げられる構成にする |
| HTTP `:8080` | なし | 別アプリケーションが `/.well-known/acme-challenge/*`、`/health`、HTTPS redirect を提供 |
| HTTPS/TURN `:8443` | `examples/turn-loopback` が多重化済み | 維持。werift 側の責務は HTTPS API / SPA / TURN/TLS に限定 |
| 証明書 | self-signed または env/file 指定 | 起動時セットアップでコンテナ内の一時パスへ配置し、werift が既存 env/file 指定で読む |
| 永続化 | 想定なし | 永続 volume を要求しない。再起動時は再セットアップ前提 |
| README | ローカル Docker 手順のみ | 80/443 公開構成、起動時セットアップ、必要 env、非永続運用時の注意点を追記 |

### Docker / 起動方式
- `examples/turn-loopback/Dockerfile` を、**werift 本体と HTTP/ACME 用別アプリケーションを同梱した単一イメージ**へ変更する。
- `EXPOSE 8080 8443` に変更する。
- 両プロセスと証明書セットアップを扱うため、**entrypoint スクリプト**を追加する。
- entrypoint では最低限次を扱う。
  1. challenge 用 webroot と証明書配置先ディレクトリ作成
  2. 初回セットアップ（証明書取得または生成）
  3. HTTP/ACME 用アプリ起動
  4. werift server 起動
  5. signal 伝播と正常終了

### HTTP / ACME 用別アプリケーション
- `:8080` の責務は `examples/turn-loopback/server/main.ts` ではなく、**別アプリケーション**に持たせる。
- そのアプリケーションは以下を提供する。
  - `/.well-known/acme-challenge/*` は webroot から静的配信
  - `/health` は平文 HTTP で返せる
  - それ以外は `https://<public-host><path>` へ 301/308 redirect
- 実装方式は Dockerfile で同梱しやすいものを優先する。  
  例: 軽量 HTTP サーバ、Nginx、Caddy など。ただし ticket では**werift 本体とは別プロセスであること**を満たせばよい。

### werift サーバー側
- `examples/turn-loopback/server/main.ts` は引き続き `:8443` 側のみを担当する。
  - HTTPS API
  - SPA 配信
  - TURN/TLS 多重化
- 平文 HTTP listener や ACME challenge 配信を `main.ts` に追加する対応は、このタスクでは**不要**とする。

### 証明書連携
- 既存の `TURN_LOOPBACK_CERT_FILE` / `TURN_LOOPBACK_KEY_FILE` を流用し、起動時セットアップで作られた証明書ファイルを読む構成を基本にする。  
  (`examples/turn-loopback/server/main.ts:509-537`)
- 追加整理したい環境変数の例:
  - `CERTBOT_DOMAINS`
  - `CERTBOT_EMAIL`
  - `CERTBOT_STAGING`
  - `CERTBOT_WEBROOT`
  - `CERTBOT_STATE_DIR`
  - `CERTBOT_RENEW_INTERVAL`
- 証明書・challenge webroot は**コンテナ内パスに閉じる**。README に永続 volume を必須要件としては書かない。

### 公開 `turns:` URL
- 現在の `turnUrl` 解決は **bind port (`8443`) を fallback に使う**ため、`docker run -p 443:8443` では外向き URL がずれる可能性がある。  
  (`examples/turn-loopback/server/main.ts:121-124,471-485`)
- そのため、`TURN_LOOPBACK_PUBLIC_HOST` だけでなく、**public authority を明示できる設計**にするのが安全。
  - 例: `TURN_LOOPBACK_PUBLIC_AUTHORITY=example.com:443`
  - あるいは `TURN_LOOPBACK_PUBLIC_PORT=443` を別管理

### README / 実行手順
- `examples/turn-loopback/README.md` を更新し、少なくとも以下を載せる。
  - build 手順
  - `docker run -p 80:8080 -p 443:8443`
  - 起動時セットアップで必要な env
  - HTTP/ACME 用別アプリケーションの役割
  - 証明書をコンテナ内で毎回セットアップする前提
  - 非永続運用時の制約（再起動時の再取得、レート制限注意など）

## 3. 技術的な実装アプローチを調査し結果を簡潔にまとめる

### 再利用できる既存実装
- **HTTPS + TURN/TLS 同一ポート多重化**は、すでに `routeSecureSocket()` で実現済み。  
  (`examples/turn-loopback/server/main.ts:396-406`)
- **TURN への TLS socket handoff** も、`NodeTurnServer.attachTlsSocket()` があるので追加改修は原則不要。  
  (`packages/ice-server/src/node/turnServer.ts:172-183`)
- **証明書の env / file 読み込み**も既存実装を流用できる。  
  (`examples/turn-loopback/server/main.ts:509-537`)

### 推奨方針
1. **8443 側の werift ロジックは極力そのまま使う**  
   HTTPS API / SPA 配信 / TURN/TLS 多重化は既存実装を維持する。

2. **8080 側は別アプリケーションに分離する**  
   ACME challenge と redirect は Dockerfile で同梱した別プロセスに担当させる。

3. **証明書は起動時にコンテナ内へ配置する**  
   werift は既存の `*_CERT_FILE` / `*_KEY_FILE` 経由で読むだけにする。

4. **Docker は multi-process を明示管理する**  
   entrypoint でセットアップと各プロセス起動順を管理し、signal / exit code を適切に扱う。

5. **public URL 解決は bind port と分離する**  
   internal `8443` と external `443` を分けて扱う。

## 4. 考慮すべき制約や注意点

- **`main.ts` の責務を増やさない**  
  今回の要求である HTTP challenge 配信や redirect は、werift server ではなく別アプリケーション側で実現する。

- **永続 volume 前提にしない**  
  `/etc/letsencrypt` や challenge webroot の永続化は必須要件にしない。コンテナ再起動時は状態が失われる前提で設計する。

- **ACME のレート制限に注意が必要**  
  証明書を毎起動ごとに本番発行する構成は、再起動頻度によっては Let’s Encrypt の rate limit に抵触し得る。README で staging 利用や運用上の注意を明記する必要がある。

- **証明書更新の扱いを決める必要がある**  
  非永続前提では長期 renew より「起動時セットアップ」を主軸にしたほうが整合的。renew ループを持つかどうかは、コンテナ寿命と運用想定に合わせて明示する。

- **公開 `turns:` URL が壊れやすい**  
  いまの実装は `Host` ヘッダに port が無いと `8443` を補うため、外側が `443` のとき `turns:example.com:8443` を返し得る。

- **challenge path だけは redirect してはいけない**  
  `/.well-known/acme-challenge/*` は HTTP でそのまま返す必要がある。

- **build context は repo root 前提のまま**  
  既存 server は workspace source を直接参照しているため、`docker build -f examples/turn-loopback/Dockerfile .` 前提は維持される。

## 5. 完了条件

1. Docker image が **HTTP `:8080` 用別アプリケーション**と **HTTPS+TURN `:8443` の werift server** を同一コンテナ内で起動できる。  
2. `docker run -p 80:8080 -p 443:8443` の構成が README に明記されている。  
3. `/.well-known/acme-challenge/*` が別アプリケーション経由で challenge webroot から配信される。  
4. HTTP のその他リクエストが HTTPS へ redirect される。  
5. HTTPS `:8443` 側で、既存どおり SPA 配信・`POST/PUT /session`・TURN/TLS 多重化が動く。  
6. 起動時セットアップで証明書ファイルがコンテナ内に用意され、app がそれを読める。  
7. 永続 volume を必須としない運用手順が README に整理されている。  
8. 返却される `turns:` URI が **公開 DNS 名と 443** に整合する。  
9. `examples/turn-loopback/server/main.ts` に HTTP listener / ACME challenge 配信を追加しなくても要件を満たせる構成になっている。  
10. README に build / run / env / 起動時セットアップ / 非永続運用時の注意点が整理されている。  
11. ローカル検証用の自己署名証明書 fallback を残すか、残さないなら README で切り替え条件が説明されている。  
