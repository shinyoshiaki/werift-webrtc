│ "**/AGENTS.md"

  │ "**/Dockerfile*"

  │ "NodeTurnServer|turnServer|certbot|\.well-known/acme-challenge|turns:|create
  │ DataChannel\(|onDataChannel|ondatachannel" in *.{ts,tsx,js,md,json}

  │ examples/turn-loopback/AGENTS.md


  │ examples/turn-loopback/Dockerfile


  │ packages/ice-server/AGENTS.md


  │ examples/turn-loopback/package.json

  │ examples/turn-loopback/README.md

  │ examples/turn-loopback/src/App.tsx

  │ examples/turn-loopback/server/main.ts

  │ examples/turn-loopback/server/main.ts

  │ packages/ice-server/src/index.ts

  │ examples/turn-loopback/server/publicAuthority.ts

  │ packages/webrtc/src/utils.ts

  │ packages/ice-server/src/node/turnServer.ts

  │ packages/ice-server/src/node/turnServer.ts

  │ packages/ice-server/package.json

  │ packages/ice-server/chrome-e2e/server/main.ts

  │ e2e/server/turn.ts


  │ packages/ice-server/src/node/turnServer.ts

  │ "acme|certbot|80\b|8080\b|8443\b|\.well-known/acme-challenge|redirect|HTTPS"
  │ in *.{ts,tsx,md,Dockerfile,json} (examples/turn-loopback,
  │ packages/ice-server)

  │ "attachTlsSocket\(|external:\s*true|getPassword\(" in *.ts


  │ "dockerfile|Dockerfile|certbot|acme|80 / 443|8443|8080"
  │ (TICKET-ticket-e1d1625a-60f6-4e37-9787-ddb11b47e071.md,
  │ TICKET-ticket-7fc3e14a-3f62-4cb1-851e-aa120523f974.md)

  │ "docker:build|docker run|EXPOSE|TURN_LOOPBACK_PORT|TURN_LOOPBACK_CERT_FILE|T
  │ URN_LOOPBACK_KEY_FILE" in *.{md,json,ts,Dockerfile} (examples/turn-loopback)

  │ "**/.dockerignore"

  │ "healthcheck|HEALTHCHECK|/health" in *.{ts,md,Dockerfile,json,yml,yaml}

  │ examples/turn-loopback/chrome-e2e/tests/hosted.test.ts

  │ examples/turn-loopback/chrome-e2e/tests/dev.test.ts


  │ examples/turn-loopback/chrome-e2e/tests/fixture.ts

調査結果として、このタスクは**Dockerfileの差し替えだけでは完結せず**、`examples/turn-loopback` の**起動方式・HTTPリスナー・公開URL解決**まで含めて詳細化するのが適切です。親チケットの中核機能はすでに実装済みで、今回の本体は**公開運用向け単一コンテナ化**です。

## 1. タスクの目的と背景

- 親チケットで必要だったコア機能は、すでに `examples/turn-loopback` にあります。  
  - HTTPS `POST /session` / `PUT /session`
  - server-offer / client-answer
  - DataChannel echo
  - HTTPS と TURN/TLS の同一ポート多重化
  - クライアント SPA  
  (`examples/turn-loopback/server/main.ts`, `examples/turn-loopback/src/App.tsx`)

- `packages/ice-server` 側も、外部TLS listenerからTURNへソケットを渡す仕組みがすでにあります。  
  (`packages/ice-server/src/node/turnServer.ts:31-49,172-183`)

- ただし現状の Docker 配布は**ローカル確認用**です。  
  - `examples/turn-loopback/Dockerfile` は Node イメージで `npm run server` を起動するだけ
  - `EXPOSE` は `8443` のみ
  - README も `docker run -p 8443:8443` 前提  
  (`examples/turn-loopback/Dockerfile:1-20`, `examples/turn-loopback/README.md:52-63`)

- また、現在の server は**TLS listener 上で HTTPS/TURN を多重化**しており、**平文 HTTP :8080**, **ACME challenge 配信**, **HTTP→HTTPS redirect** は未対応です。  
  (`examples/turn-loopback/server/main.ts:159-169,396-406`)

- したがってこのタスクの目的は、既存 example を  
  **「自己署名証明書で 8443 を直接叩く開発用コンテナ」**から  
  **「DNS → 静的IP → GCE COS → docker run で 80/443 公開できる単一コンテナ」**へ引き上げることです。

## 2. 実装すべき具体的な機能や変更内容

| 領域 | 現状 | 今回必要 |
| --- | --- | --- |
| Dockerfile | 単一 Node 実行、8443のみ公開 | Certbot 同梱、80/443 想定の実行構成、起動スクリプト追加 |
| HTTP | なし | `:8080` で `/.well-known/acme-challenge/*` 配信、その他は HTTPS へ redirect |
| HTTPS/TURN | `:8443` で多重化済み | 維持 |
| 証明書 | bundled self-signed か env/file 指定 | Certbot の発行/更新ファイルを読む運用へ接続 |
| 公開URL解決 | internal port ベース | public 443 を正しく返す仕組みに修正 |
| README | ローカル Docker 手順のみ | GCE/COS 向け run 手順・volume・env を追記 |

### Docker / 起動方式
- `examples/turn-loopback/Dockerfile` を、**Certbot を含む単一コンテナ構成**に変更する。
- `EXPOSE 8080 8443` に変更する。
- app と Certbot をまとめて起動するため、**entrypoint スクリプト**を追加する。
- entrypoint で最低限次を扱う。
  1. challenge webroot ディレクトリ作成
  2. 初回証明書取得
  3. app 起動
  4. renew ループ
  5. signal 伝播と正常終了

### サーバー側
- `examples/turn-loopback/server/main.ts` に**平文HTTP listener**を追加する。
- `:8080` では以下を提供する。
  - `/.well-known/acme-challenge/*` は webroot から静的配信
  - `/health` は必要なら平文でも返せるようにする
  - それ以外は `https://<public-host><path>` へ 301/308 redirect
- 既存の `:8443` 側は引き続き
  - HTTPS API
  - SPA 配信
  - TURN/TLS 多重化  
  を担当する。

### 証明書連携
- 既存の `TURN_LOOPBACK_CERT_FILE` / `TURN_LOOPBACK_KEY_FILE` はすでにあるため、これを Let’s Encrypt の live パスに向ける形を基本にする。  
  (`examples/turn-loopback/server/main.ts:509-537`)
- Certbot 用に追加整理したい環境変数:
  - `CERTBOT_DOMAINS`
  - `CERTBOT_EMAIL`
  - `CERTBOT_STAGING`
  - `CERTBOT_WEBROOT`
  - `CERTBOT_RENEW_INTERVAL`
- 永続化前提の volume パスも README に明記する。
  - `/etc/letsencrypt`
  - `/.well-known/acme-challenge` 用 webroot

### 公開 `turns:` URL
- 現在の `turnUrl` 解決は**bind port (`8443`) を fallback に使う**ため、`docker run -p 443:8443` では外向きURLがずれる可能性がある。  
  (`examples/turn-loopback/server/main.ts:121-124,471-485`)
- そのため、`TURN_LOOPBACK_PUBLIC_HOST` だけでなく、**public authority を明示できる設計**にするのが安全。
  - 例: `TURN_LOOPBACK_PUBLIC_AUTHORITY=example.com:443`
  - あるいは `TURN_LOOPBACK_PUBLIC_PORT=443` を別管理

### README / 実行手順
- `examples/turn-loopback/README.md` を更新し、少なくとも以下を載せる。
  - build 手順
  - GCE COS 上の `docker run` 例
  - `-p 80:8080 -p 443:8443`
  - Certbot 用 volume
  - ドメイン/メール設定
  - A/AAAA レコードと静的外部IP前提
  - 初回証明書取得と更新の説明

## 3. 技術的な実装アプローチを調査し結果を簡潔にまとめる

### 再利用できる既存実装
- **HTTPS + TURN/TLS 同一ポート多重化**は、すでに `routeSecureSocket()` で実現済み。  
  (`examples/turn-loopback/server/main.ts:396-406`)
- **TURN への TLS socket handoff** も、`NodeTurnServer.attachTlsSocket()` があるので追加改修は原則不要。  
  (`packages/ice-server/src/node/turnServer.ts:172-183`)
- **証明書の env / file 読み込み**も既存実装を流用できる。  
  (`examples/turn-loopback/server/main.ts:509-537`)

### 推奨方針
1. **8443 側は現状維持**  
   HTTPS API / SPA 配信 / TURN/TLS 多重化はそのまま使う。

2. **8080 側を追加**  
   ACME 用 webroot と HTTPS redirect を担当させる。

3. **Certbot は webroot 方式**  
   standalone ではなく webroot を使う。  
   理由は、要件が `/.well-known/acme-challenge/*` を app が配信する前提だから。

4. **Docker は multi-process を明示管理**  
   app と Certbot を単に `&` で並べるのではなく、entrypoint で signal / restart / renew を管理する。

5. **public URL 解決は bind port と分離**  
   internal `8443` と external `443` を分けて扱う。

## 4. 考慮すべき制約や注意点

- **Dockerfileだけでは足りない**  
  現状 server に平文 HTTP listener がないため、ACME challenge 配信と redirect は server 側変更が必要。

- **公開 `turns:` URL が壊れやすい**  
  いまの実装は `Host` ヘッダに port が無いと `8443` を補うため、外側が `443` のとき `turns:example.com:8443` を返し得る。

- **証明書更新を反映する仕組みが必要**  
  server は起動時に証明書を読み込むだけなので、renew 後に何もしないと古い証明書のままになる。

- **Certbot の状態は永続化が必要**  
  volume なしだとコンテナ再作成で証明書も ACME 状態も失う。

- **challenge path は redirect してはいけない**  
  `/.well-known/acme-challenge/*` だけは HTTP でそのまま返す必要がある。

- **既存の WebRTC 方針は維持する**  
  server peer に TURN client 設定や `iceTransportPolicy: "relay"` を入れない方針は変えない。

- **build context は repo root 前提のまま**  
  既存 server は workspace source を直接参照しているため、`docker build -f examples/turn-loopback/Dockerfile .` 前提は維持される。

## 5. 完了条件

1. Docker image が **HTTP :8080 / HTTPS+TURN :8443** を内部で起動できる。  
2. `docker run -p 80:8080 -p 443:8443` の構成が README に明記されている。  
3. HTTP `/.well-known/acme-challenge/*` が challenge webroot から配信される。  
4. HTTP のその他リクエストが HTTPS へ redirect される。  
5. HTTPS `:8443` 側で、既存どおり SPA 配信・`POST/PUT /session`・TURN/TLS 多重化が動く。  
6. Certbot の初回発行と renew の流れが単一コンテナ内で扱える。  
7. app は Let’s Encrypt の証明書ファイルを読める。  
8. 返却される `turns:` URI が **公開DNS名と 443** に整合する。  
9. server peer に TURN 設定や `iceTransportPolicy: "relay"` を入れない既存方針が維持される。  
10. README に build / run / env / volume / DNS・静的IP 前提が整理されている。  
11. ローカル検証用の自己署名証明書 fallback を残すか、残さないなら README で明確に切り替え条件が説明されている。