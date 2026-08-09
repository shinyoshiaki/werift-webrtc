# TURN: 1回のCreatePermission/ChannelBindの拒否が、同じ割り当て上の後続のすべてのピアアドレスを汚染する原因分析と修正方針

- 関連仕様: RFC 8656 (TURN)
  - https://www.rfc-editor.org/rfc/rfc8656.html

## 1. 概要

`TurnProtocol` の `CreatePermission` / `ChannelBind` 処理では、進行中の Promise を allocation 全体で共有しています。

現状は概ね次の状態です。

```ts
private creatingPermission: Promise<void> = Promise.resolve();
private channelBinding?: Promise<void>;

private permissionByAddr: { [addr: string]: boolean } = {};
private channelByAddr: {
  [addr: string]: { number: number; address: Address };
} = {};

private channelRefreshAt = 0;
```

この設計では、ある peer address に対する `CreatePermission` または `ChannelBind` が reject すると、
その失敗済み Promise が別の peer address の処理にも影響します。

結果として、

> 1つの peer address が TURN server から拒否されただけで、同じ TURN allocation を利用する他の正常な peer address まで通信不能になる

という問題が発生します。

ICE connectivity check では複数 candidate pair が順番に試されるため、
拒否される peer に対する TURN 操作が先に走るだけで、
その後の正常な `relay <-> relay` candidate pair まで失敗する可能性があります。

---

## 2. 現在の `getPermission()` の問題

現行コードは概ね次の構造です。

```ts
async getPermission(addr: Address) {
  await this.creatingPermission;

  const permitted = this.permissionByAddr[addr.join(":")];

  if (!permitted) {
    this.creatingPermission = this.createPermission(addr);

    this.permissionByAddr[addr.join(":")] = true;

    await this.creatingPermission.catch((e) => {
      log("createPermission error", e);
      throw e;
    });
  }
}
```

### 2.1 rejected Promise が allocation 全体を poison する

最も直接的な問題です。

```ts
await this.creatingPermission;
```

によって、現在の peer address に関係なく、
前回の `CreatePermission` Promise を await しています。

例えば次の順番の場合:

```text
Peer A
  CreatePermission(A)
    -> TURN server が拒否
    -> creatingPermission が rejected Promise になる

Peer B
  getPermission(B)
    -> await creatingPermission
    -> A の rejection が再送出される
    -> CreatePermission(B) まで到達しない
```

さらに `creatingPermission` は rejection 後もリセットされません。

したがって一度 reject すると、allocation の lifetime 中に呼ばれる
後続の `getPermission()` がすべて同じ rejection を受ける可能性があります。

---

### 2.2 permission を成功前にキャッシュしている

現在は、

```ts
this.permissionByAddr[addr.join(":")] = true;
await this.creatingPermission;
```

という順番です。

そのため、

```text
CreatePermission開始
↓
permissionByAddr[key] = true
↓
TURN server が拒否
```

となった場合でも、

```ts
permissionByAddr[key] === true
```

が残ります。

つまり実際には permission が作成されていないのに、
werift 内部では permission 済みとして扱われます。

これは retry を妨害します。

---

### 2.3 permission cache key が IP + port になっている

現在は、

```ts
addr.join(":")
```

を key として使用しています。

しかし TURN Permission は peer **IP address 単位**です。

同じ IP の異なる port は同じ permission を共有します。

したがって permission key は port を含めず、

```ts
private permissionKey(addr: Address) {
  return addr[0];
}
```

のように IP address 単位にするのが適切です。

一方 ChannelBind は peer transport address、すなわち IP + port 単位なので、
permission と channel で key の定義を分離する必要があります。

---

## 3. 現在の `getChannel()` の問題

現行コードは概ね次の構造です。

```ts
async getChannel(addr: Address) {
  if (this.channelBinding) {
    await this.channelBinding;
  }

  let channel = this.channelByAddr[addr.join(":")];

  if (!channel) {
    this.channelByAddr[addr.join(":")] = {
      number: this.channelNumber++,
      address: addr,
    };

    channel = this.channelByAddr[addr.join(":")];
    this.addrByChannel[channel.number] = addr;

    this.channelBinding = this.channelBind(channel.number, addr);

    await this.channelBinding.catch((e) => {
      log("channelBind error", e);
      throw e;
    });

    this.channelRefreshAt =
      int(Date.now() / 1000) + this.channelRefreshTime;

    this.channelBinding = undefined;
  }

  return channel;
}
```

### 3.1 ChannelBind rejection が別 peer に伝播する

`channelBinding` も allocation 全体で1つです。

```ts
if (this.channelBinding) {
  await this.channelBinding;
}
```

のため、

```text
ChannelBind(A)
  -> reject

getChannel(B)
  -> await channelBinding
  -> A の rejection を受ける
```

となります。

---

### 3.2 rejection 時に `channelBinding` がリセットされない

現在は、

```ts
await this.channelBinding.catch((e) => {
  throw e;
});

this.channelBinding = undefined;
```

となっています。

rejection が発生すると `throw e` により後続行へ進まないため、

```ts
this.channelBinding = undefined;
```

は実行されません。

結果として rejected Promise が残り続けます。

---

### 3.3 ChannelBind 失敗時に channel mapping が残る

ChannelBind の成功前に、

```ts
this.channelByAddr[key] = channel;
this.addrByChannel[channel.number] = addr;
```

を登録しています。

これは完全に間違いというわけではありません。

TURN では ChannelBind success response より先に ChannelData が届く可能性があるため、
request を送った時点で provisional mapping を用意しておくことには意味があります。

問題は、

> ChannelBind が失敗した場合に provisional mapping を rollback していない

ことです。

現在は失敗しても、

```ts
channelByAddr[key]
addrByChannel[channelNumber]
```

が残るため、その後の `getChannel(addr)` が
「既に channel が存在する」と誤認する可能性があります。

---

## 4. 根本原因

根本原因は単純な「Promise の reset 忘れ」だけではありません。

現在の設計では、

```text
TURN allocation
 ├─ creatingPermission: Promise
 ├─ channelBinding: Promise
 ├─ channelRefreshAt
 └─ peerごとのcache
```

となっており、

**peer 単位の操作状態と allocation 全体の状態が混在しています。**

`CreatePermission` / `ChannelBind` は peer ごとの操作ですが、
in-flight Promise が allocation-global になっています。

そのため peer A の transaction failure が peer B に伝播します。

修正では、

```text
allocation-global state
    と
peer-specific state
```

を明確に分離する必要があります。

---

# 5. 推奨する修正方針

単純に、

```ts
try {
  await this.creatingPermission;
} finally {
  this.creatingPermission = undefined;
}
```

のように直すだけでも poisoning 自体は軽減できます。

しかし以下の問題は残ります。

- 別 peer の処理が同じ Promise を待つ
- permission success 前の cache
- failed ChannelBind mapping
- same-peer concurrent request
- channel refresh state の共有

そのため、peer 単位の in-flight state に変更することを推奨します。

---

## 6. CreatePermission の修正

### 6.1 状態

以下のように変更します。

```ts
private permissionQueue: Promise<void> = Promise.resolve();

private creatingPermissionByAddr =
  new Map<string, Promise<void>>();

private permissionByAddr: {
  [peerIp: string]: boolean;
} = {};
```

### 6.2 queue が必要な理由

`requestWithRetry()` は、

- `server`
- `nonce`
- `realm`
- `integrityKey`

など allocation 共通の認証状態を更新します。

そのため、今回の修正だけで TURN control request を全面的に並列化すると、
認証 state 更新との race を増やす可能性があります。

まずは現在の直列性を維持しつつ、

> 前の operation の rejection を次の operation に伝播させない queue

に変更する方が安全です。

---

### 6.3 queue tail は必ず resolve させる

重要なのは以下です。

```ts
const operation =
  this.permissionQueue.then(() => doSomething());

this.permissionQueue = operation.then(
  () => undefined,
  () => undefined,
);

return operation;
```

呼び出し元には本来の rejection を返しますが、
queue tail 自体には rejection を残しません。

そのため、

```text
CreatePermission(A)
  -> reject

CreatePermission(B)
  -> A の rejection を継承しない
  -> 実行可能
```

になります。

---

## 7. `getPermission()` 実装案

```ts
private permissionKey(addr: Address) {
  // TURN permission は peer IP address 単位
  return addr[0];
}

async getPermission(addr: Address) {
  const key = this.permissionKey(addr);

  if (this.permissionByAddr[key]) {
    return;
  }

  const existing =
    this.creatingPermissionByAddr.get(key);

  if (existing) {
    return existing;
  }

  const operation = this.permissionQueue.then(
    async () => {
      // queue待ち中に別 caller が成功させた可能性を再確認
      if (this.permissionByAddr[key]) {
        return;
      }

      await this.createPermission(addr);

      // 成功後にのみcacheする
      this.permissionByAddr[key] = true;
    },
  );

  // rejectionを次のpeerへ伝播させない
  this.permissionQueue = operation.then(
    () => undefined,
    () => undefined,
  );

  this.creatingPermissionByAddr.set(
    key,
    operation,
  );

  try {
    await operation;
  } catch (error) {
    log("createPermission error", error);
    throw error;
  } finally {
    if (
      this.creatingPermissionByAddr.get(key) ===
      operation
    ) {
      this.creatingPermissionByAddr.delete(key);
    }
  }
}
```

これにより以下を満たせます。

```text
A attempt #1 -> fail
A attempt #2 -> retry可能

A -> fail
B -> success可能

Aへの同時複数call
 -> 同じPromiseを共有
 -> CreatePermissionは1回だけ
```

---

## 8. `createPermission()` は `requestWithRetry()` を利用する

現在 `ChannelBind` は `requestWithRetry()` を使用している一方、
`CreatePermission` は直接 `request()` を使用しています。

修正時に一貫させることを推奨します。

```ts
private async createPermission(
  peerAddress: Address,
) {
  const request = new Message(
    methods.CREATE_PERMISSION,
    classes.REQUEST,
  );

  request
    .setAttribute(
      "XOR-PEER-ADDRESS",
      peerAddress,
    )
    .setAttribute("USERNAME", this.username)
    .setAttribute("REALM", this.realm)
    .setAttribute("NONCE", this.nonce);

  await this.requestWithRetry(
    request,
    this.server,
  );
}
```

これにより stale nonce (`438`) 等に対する既存 retry 処理を
CreatePermission でも利用できます。

---

# 9. ChannelBind の修正

ChannelBind も同様に peer 単位の in-flight state を持たせます。

```ts
private channelBindQueue: Promise<void> =
  Promise.resolve();

private channelBindingByAddr =
  new Map<string, Promise<TurnChannel>>();
```

channel は IP + port 単位なので、
permission key とは分けます。

```ts
private channelKey(addr: Address) {
  return JSON.stringify(addr);
}
```

`addr.join(":")` は IPv6 表現との境界が分かりにくいため、
structured な key の方が安全です。

---

## 10. channel state を構造体化する

現在 `channelRefreshAt` が allocation-global なので、
channel state に含めます。

```ts
interface TurnChannel {
  number: number;
  address: Address;
  refreshAt: number;
}
```

```ts
private channelByAddr: {
  [key: string]: TurnChannel;
} = {};
```

これにより channel A/B の refresh deadline を独立して管理できます。

---

## 11. initial ChannelBind の provisional mapping と rollback

ChannelBind request 前に provisional mapping を登録します。

```ts
private async ensureChannel(
  addr: Address,
): Promise<TurnChannel> {
  const key = this.channelKey(addr);
  const now = int(Date.now() / 1000);

  let channel = this.channelByAddr[key];

  if (
    channel &&
    channel.refreshAt > now
  ) {
    return channel;
  }

  const isNew = !channel;

  if (!channel) {
    channel = {
      number: this.channelNumber++,
      address: addr,
      refreshAt: 0,
    };

    // success response より先に ChannelData が来ても
    // decodeできるよう provisional mapping を作成
    this.channelByAddr[key] = channel;
    this.addrByChannel[channel.number] = addr;
  }

  try {
    await this.channelBind(
      channel.number,
      addr,
    );

    channel.refreshAt =
      int(Date.now() / 1000) +
      this.channelRefreshTime;

    return channel;
  } catch (error) {
    if (isNew) {
      // 初回bindが失敗した場合のみrollback
      delete this.channelByAddr[key];
      delete this.addrByChannel[channel.number];
    }

    throw error;
  }
}
```

---

## 12. failed channel number は再利用しない

初回 ChannelBind が timeout した場合、

```text
server:
    ChannelBind成功

network:
    success response消失

client:
    timeoutとして認識
```

というケースを完全には否定できません。

そのため失敗後に、

```ts
this.channelNumber--;
```

などで channel number を巻き戻すべきではありません。

一度使用した number は捨て、
次回 retry では新しい channel number を利用する方が安全です。

---

## 13. `getChannel()` 実装案

```ts
async getChannel(
  addr: Address,
): Promise<TurnChannel> {
  const key = this.channelKey(addr);

  const existing =
    this.channelBindingByAddr.get(key);

  if (existing) {
    return existing;
  }

  const operation =
    this.channelBindQueue.then(() =>
      this.ensureChannel(addr),
    );

  // rejectを次のpeerへ伝播させない
  this.channelBindQueue = operation.then(
    () => undefined,
    () => undefined,
  );

  this.channelBindingByAddr.set(
    key,
    operation,
  );

  try {
    return await operation;
  } catch (error) {
    log("channelBind error", error);
    throw error;
  } finally {
    if (
      this.channelBindingByAddr.get(key) ===
      operation
    ) {
      this.channelBindingByAddr.delete(key);
    }
  }
}
```

これにより、

```text
ChannelBind(A)
  -> reject

ChannelBind(B)
  -> success
```

が同一 allocation でも成立します。

また、

```ts
await Promise.all([
  getChannel(addr),
  getChannel(addr),
  getChannel(addr),
]);
```

でも同じ peer に対して ChannelBind を複数発行せずに済みます。

---

# 14. `channelRefreshAt` を channel 単位にする

現在の、

```ts
private channelRefreshAt = 0;
```

は allocation 全体で共有されています。

例えば、

```text
T=0
  Channel A bind
  A refreshAt = 500

T=100
  Channel B bind
  global refreshAt = 600
```

となると、
B の bind によって A の refresh deadline まで変更されます。

そのため、

```ts
interface TurnChannel {
  number: number;
  address: Address;
  refreshAt: number;
}
```

として peer/channel 単位に保持すべきです。

---

# 15. `sendData()` のフォールバック

現在の設計は概ね、

```text
ChannelBind
   |
   +-- success
   |     |
   |     +--> ChannelData
   |
   +-- failure
         |
         +--> CreatePermission
               |
               +--> Send Indication
```

になっています。

この基本構造は維持できます。

ただし現在は元の ChannelBind error を捨てているため、
デバッグ性を改善するなら以下のようにします。

```ts
let channel: TurnChannel | undefined;

try {
  channel = await this.getChannel(addr);
} catch (error) {
  log(
    "channelBind fallback to Send indication",
    {
      addr,
      error,
    },
  );
}

if (!channel) {
  await this.getPermission(addr);

  const indicate = new Message(
    methods.SEND,
    classes.INDICATION,
  )
    .setAttribute("DATA", data)
    .setAttribute(
      "XOR-PEER-ADDRESS",
      addr,
    );

  await this.sendStun(
    indicate,
    this.server,
  );

  return;
}

await this.send(
  encodeChannelData(
    channel.number,
    data,
  ),
  this.server,
);
```

TURN server からの 403 / 438 / timeout 等をログから追跡しやすくなります。

---

# 16. 別途検討すべき TURN refresh の問題

Issue #667 の直接原因ではありませんが、
修正中に関連する問題として確認すべき点があります。

現状:

```ts
const DEFAULT_CHANNEL_REFRESH_TIME = 500;
```

TURN では概ね、

- Permission lifetime: 300 sec
- Channel binding lifetime: 600 sec

です。

ChannelBind は associated permission も refresh しますが、
500秒周期だと permission lifetime より長くなります。

概念的には、

```text
0 sec
  ChannelBind
  permission作成

300 sec
  permission expiry

500 sec
  werift が ChannelBind refresh
```

となり、
permission が切れている時間帯が生じ得ます。

例えば以下を検討します。

```ts
const DEFAULT_CHANNEL_REFRESH_TIME = 240;
```

または Permission/Channel の refresh state を明示的に分離します。

---

# 17. 必須 regression test

## 17.1 CreatePermission failure isolation

```text
CreatePermission(A)
  -> reject

CreatePermission(B)
  -> success
```

期待値:

- B が A の rejection を受けない
- B の request が TURN server へ送信される

---

## 17.2 CreatePermission retry

```text
CreatePermission(A) #1
  -> reject

CreatePermission(A) #2
  -> success
```

期待値:

- failed permission が成功扱いで cache されない
- 2回目の request が実際に送られる

---

## 17.3 concurrent same permission

```ts
await Promise.all([
  getPermission(A),
  getPermission(A),
]);
```

期待値:

- CreatePermission transaction は1回だけ
- callers は同じ in-flight Promise を共有

---

## 17.4 ChannelBind failure isolation

```text
ChannelBind(A)
  -> reject

ChannelBind(B)
  -> success
```

期待値:

- B は正常に bind 可能

---

## 17.5 failed initial ChannelBind rollback

```text
ChannelBind(A)
  -> reject
```

期待値:

```ts
channelByAddr[A] === undefined
addrByChannel[failedNumber] === undefined
```

---

## 17.6 ChannelBind retry

```text
ChannelBind(A, 0x4000)
  -> reject

ChannelBind(A, 0x4001)
  -> success
```

期待値:

- retry可能
- failed channel number を再利用しない

---

## 17.7 concurrent same ChannelBind

```ts
await Promise.all([
  getChannel(A),
  getChannel(A),
]);
```

期待値:

- ChannelBind transaction は1回だけ

---

## 17.8 refresh failure isolation

```text
Channel A refresh
  -> reject

Channel B initial bind
  -> success
```

期待値:

- A の refresh failure が B に伝播しない

---

## 17.9 independent refresh deadline

```text
Channel A bind
Channel B bind
```

期待値:

- A/B が独立した `refreshAt` を持つ
- B の bind が A の refresh deadline を変更しない

---

## 17.10 Issue #667 end-to-end regression

最重要テストです。

```text
Peer A
  ChannelBind
    -> TURN server rejects

  CreatePermission
    -> TURN server rejects

Peer B
  ChannelBind
    -> success

  ChannelData
    -> success
```

期待値:

> Peer A に対する拒否があっても、Peer B の TURN relay path が正常に利用できる。

ICE integration test としては、

```text
candidate pair #1
  rejected peer
  -> fail

candidate pair #2
  relay <-> relay
  -> success
```

となるケースを再現し、
ICE connection が最終的に `connected/completed` へ到達することを確認します。

---

# 18. 完了条件

Issue #667 の修正完了条件は以下を推奨します。

- [ ] 1 peer の `CreatePermission` rejection が別 peer に伝播しない
- [ ] 1 peer の `ChannelBind` rejection が別 peer に伝播しない
- [ ] rejected Promise が allocation-global state に残らない
- [ ] `CreatePermission` 成功前に permission cache を確定しない
- [ ] failed permission は後続呼び出しで retry できる
- [ ] failed initial ChannelBind の provisional mapping を rollback する
- [ ] failed ChannelBind は後続呼び出しで retry できる
- [ ] failed channel number を即時再利用しない
- [ ] same-peer concurrent operation を1 transactionに集約する
- [ ] ChannelBind success response より先に到着する ChannelData を処理可能
- [ ] channel refresh state を peer/channel 単位で管理する
- [ ] UDP TURN の既存動作を壊さない
- [ ] TURN over TCP の既存動作を壊さない
- [ ] TURN over TLS の既存動作を壊さない
- [ ] 拒否 candidate の後に正常な relay candidate が試された場合でも ICE が接続成功する

---

# 19. 推奨する実装順序

変更を以下の単位に分けるとレビューしやすくなります。

### Step 1: CreatePermission state isolation

- `creatingPermission` を廃止
- `permissionQueue`
- `creatingPermissionByAddr`
- success 後のみ cache
- permission key を IP 単位へ変更
- retry/failure isolation test

### Step 2: ChannelBind state isolation

- `channelBinding` を廃止
- `channelBindQueue`
- `channelBindingByAddr`
- provisional mapping + failure rollback
- same-peer deduplication
- failure isolation test

### Step 3: Channel refresh state の peer 化

- `channelRefreshAt` を削除
- `TurnChannel.refreshAt` へ移動
- 複数 peer refresh test

### Step 4: Integration regression

- rejected peer -> valid peer
- relay <-> relay
- UDP/TCP/TLS TURN

### Step 5: その他

- Permission 300 sec と整合する refresh interval の修正
- TURN permission/channel expiration をより明示的に管理する設計

---

# 20. 結論

> peer-specific な TURN operation の in-flight Promise を allocation-global に保持し、
> rejected Promise を後続 peer が await してしまうこと

です。

ただし実際にはそれに加えて、

- permission success 前の cache
- failed ChannelBind mapping の残留
- retry不能
- global `channelRefreshAt`

が同じ state management 設計から派生しています。

そのため、最小限の `finally` 修正ではなく、

```text
allocation state
+
peer-specific in-flight/cache state
```

へ責務を分離する修正を推奨します。

同一 peer に対する concurrent request の重複も防止でき、
今後の TURN permission/channel refresh 管理も拡張しやすくなります。
