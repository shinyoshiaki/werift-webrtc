/**
 * DataChannel オプションベンチマークテスト
 * 
 * このテストはDataChannelの設定オプションによる性能の違いを評価します。
 * - ordered (順序保証)
 * - maxRetransmits (最大再送回数)
 * - maxPacketLifeTime (パケット生存時間)
 * の各設定を変えてベンチマークを行います。
 */

import { randomBytes } from "crypto";
import * as Werift from "../packages/webrtc/src";

/**
 * テスト設定インターフェース
 */
interface TestConfig {
  name: string;       // テスト名
  size: number;       // データサイズ (bytes)
  iterations: number; // 繰り返し回数
  ordered?: boolean;  // 順序保証（デフォルトはtrue）
  maxRetransmits?: number; // 最大再送回数
  maxPacketLifeTime?: number; // パケット生存時間(ms)
}

/**
 * テスト結果インターフェース
 */
interface TestResult {
  config: TestConfig;
  rtts: number[];     // 往復時間 (ms)
  avgRtt: number;     // 平均往復時間 (ms)
  minRtt: number;     // 最小往復時間 (ms)
  maxRtt: number;     // 最大往復時間 (ms)
  medianRtt: number;  // 中央値往復時間 (ms)
  throughput: number; // スループット (Mbps)
  errorCount: number; // エラー数
  lossCount: number;  // パケットロス数（受信しなかったパケット数）
}

/**
 * 指定された設定でDataChannelのベンチマークテストを実行します
 */
async function runOptionsTest(config: TestConfig): Promise<TestResult> {
  console.log(`\n---- ${config.name} テスト開始 ----`);
  
  // 2つのピア接続を作成
  const peer1 = new Werift.RTCPeerConnection({});
  const peer2 = new Werift.RTCPeerConnection({});
  
  // ICE候補の交換
  peer1.onicecandidate = (e) => {
    if (e.candidate) {
      peer2.addIceCandidate(e.candidate);
    }
  };
  peer2.onicecandidate = (e) => {
    if (e.candidate) {
      peer1.addIceCandidate(e.candidate);
    }
  };
  
  // DataChannel作成（オプション設定）
  const channelParams = new Werift.RTCDataChannelParameters({
    label: "benchmark",
    ordered: config.ordered,
    maxRetransmits: config.maxRetransmits,
    maxPacketLifeTime: config.maxPacketLifeTime
  });
  
  const dc1 = peer1.createDataChannel("benchmark", channelParams);
  let dc2: Werift.RTCDataChannel;
  
  // エラーカウンター
  let errorCount = 0;
  let lossCount = 0;
  
  // エラーハンドリング
  dc1.error.subscribe((error) => {
    console.error(`${config.name}: エラー発生:`, error);
    errorCount++;
  });
  
  // DataChannelの受信設定
  peer2.onDataChannel.subscribe((channel) => {
    dc2 = channel;
    
    // エコーサーバーとして機能
    channel.onMessage.subscribe((msg) => {
      channel.send(msg);
    });
    
    // エラーハンドリング
    channel.error.subscribe((error) => {
      console.error(`${config.name}: 受信側エラー:`, error);
      errorCount++;
    });
  });
  
  // 接続確立
  await peer1.createOffer()
    .then((offer) => peer1.setLocalDescription(offer))
    .then(() => peer2.setRemoteDescription(peer1.localDescription!))
    .then(() => peer2.createAnswer())
    .then((answer) => peer2.setLocalDescription(answer))
    .then(() => peer1.setRemoteDescription(peer2.localDescription!));
  
  // DataChannelのオープンを待機
  await new Promise<void>((resolve) => {
    dc1.stateChanged.subscribe((state) => {
      if (state === "open") {
        resolve();
      }
    });
  });
  
  console.log(`${config.name}: DataChannel接続が確立されました`);
  console.log(`設定: ordered=${config.ordered}, maxRetransmits=${config.maxRetransmits}, maxPacketLifeTime=${config.maxPacketLifeTime}`);
  
  // テストデータ
  const testData = randomBytes(config.size);
  const results: number[] = [];
  
  // タイムアウト値（ミリ秒）- 応答がない場合のタイムアウト
  const timeout = 10000; // 10秒
  
  // 往復時間(RTT)テスト
  for (let i = 0; i < config.iterations; i++) {
    const start = performance.now();
    
    try {
      // メッセージを送信
      dc1.send(testData);
      
      // 応答を待機（タイムアウト付き）
      await Promise.race([
        new Promise<void>((resolve) => {
          dc1.onMessage.once(() => {
            const end = performance.now();
            results.push(end - start);
            resolve();
          });
        }),
        new Promise<void>((_, reject) => {
          setTimeout(() => {
            lossCount++;
            reject(new Error("応答タイムアウト"));
          }, timeout);
        })
      ]);
    } catch (err) {
      console.warn(`${config.name}: テスト ${i} でエラー: ${err}`);
      errorCount++;
    }
    
    // 進捗表示
    if (i % Math.max(1, Math.floor(config.iterations / 10)) === 0) {
      console.log(`${config.name}: テスト進捗 ${i}/${config.iterations}`);
    }
  }
  
  // 結果が0件の場合のエラー回避
  if (results.length === 0) {
    console.error(`${config.name}: 有効な測定結果がありません`);
    return {
      config,
      rtts: [],
      avgRtt: 0,
      minRtt: 0,
      maxRtt: 0,
      medianRtt: 0,
      throughput: 0,
      errorCount,
      lossCount
    };
  }
  
  // 結果集計
  const avg = results.reduce((sum, val) => sum + val, 0) / results.length;
  const min = Math.min(...results);
  const max = Math.max(...results);
  const sorted = [...results].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  
  // スループット計算 (Mbps)
  const throughput = ((config.size * 8 * 2) / (avg / 1000)) / 1_000_000;
  
  // 結果出力
  console.log(`\n---- ${config.name} 結果 ----`);
  console.log(`サンプル数: ${results.length} / ${config.iterations}`);
  console.log(`データサイズ: ${formatBytes(config.size)}`);
  console.log(`平均RTT: ${avg.toFixed(2)}ms`);
  console.log(`最小RTT: ${min.toFixed(2)}ms`);
  console.log(`最大RTT: ${max.toFixed(2)}ms`);
  console.log(`中央値RTT: ${median.toFixed(2)}ms`);
  console.log(`スループット: ${throughput.toFixed(2)} Mbps`);
  console.log(`エラー数: ${errorCount}`);
  console.log(`パケットロス数: ${lossCount}`);
  
  // 接続をクリーンアップ
  dc1.close();
  peer1.close();
  peer2.close();
  
  return {
    config,
    rtts: results,
    avgRtt: avg,
    minRtt: min,
    maxRtt: max,
    medianRtt: median,
    throughput,
    errorCount,
    lossCount
  };
}

/**
 * バイト数を人間が読みやすい形式に変換
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  else if (bytes < 1048576) return (bytes / 1024).toFixed(2) + " KB";
  else if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + " MB";
  else return (bytes / 1073741824).toFixed(2) + " GB";
}

/**
 * メインベンチマーク実行関数
 */
async function runBenchmark() {
  console.log("DataChannel オプションベンチマークを開始します...");
  
  // 共通設定
  const dataSize = 50 * 1024; // 50KB
  const iterations = 20;
  
  // テスト設定
  const configs: TestConfig[] = [
    { 
      name: "デフォルト", 
      size: dataSize, 
      iterations,
      ordered: true
    },
    { 
      name: "順序なし", 
      size: dataSize, 
      iterations,
      ordered: false
    },
    { 
      name: "再送回数制限", 
      size: dataSize, 
      iterations,
      ordered: true,
      maxRetransmits: 2
    },
    { 
      name: "パケット生存時間制限", 
      size: dataSize, 
      iterations,
      ordered: true,
      maxPacketLifeTime: 1000 // 1秒
    },
    { 
      name: "順序なし＋再送なし", 
      size: dataSize, 
      iterations,
      ordered: false,
      maxRetransmits: 0
    }
  ];
  
  // 各設定でテスト実行
  const results: TestResult[] = [];
  for (const config of configs) {
    const result = await runOptionsTest(config);
    results.push(result);
  }
  
  // 最終結果の表示
  console.log("\n========== 最終結果 ==========");
  console.table(results.map(r => ({
    "テスト名": r.config.name,
    "順序保証": r.config.ordered,
    "最大再送回数": r.config.maxRetransmits,
    "パケット生存時間": r.config.maxPacketLifeTime,
    "平均RTT (ms)": r.avgRtt.toFixed(2),
    "スループット (Mbps)": r.throughput.toFixed(2),
    "エラー数": r.errorCount,
    "パケットロス数": r.lossCount
  })));
  
  // CSVフォーマットでも出力
  console.log("\nCSVフォーマット:");
  console.log("テスト名,順序保証,最大再送回数,パケット生存時間,平均RTT(ms),中央値RTT(ms),スループット(Mbps),エラー数,パケットロス数");
  for (const r of results) {
    console.log(`${r.config.name},${r.config.ordered},${r.config.maxRetransmits || "未設定"},${r.config.maxPacketLifeTime || "未設定"},${r.avgRtt.toFixed(2)},${r.medianRtt.toFixed(2)},${r.throughput.toFixed(2)},${r.errorCount},${r.lossCount}`);
  }
  
  return results;
}

// ベンチマークを実行
runBenchmark().catch((err) => {
  console.error("エラーが発生しました:", err);
});
