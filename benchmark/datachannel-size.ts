/**
 * DataChannel サイズベンチマークテスト
 * 
 * このテストは異なるサイズのデータに対するDataChannelの性能を測定します。
 * 1KB, 10KB, 100KB, 1MB のデータサイズで往復時間(RTT)を計測します。
 */

import { randomBytes } from "crypto";
import * as Werift from "../packages/webrtc/src";

/**
 * テスト設定インターフェース
 */
interface TestConfig {
  name: string;      // テスト名
  size: number;      // データサイズ (bytes)
  iterations: number; // 繰り返し回数
}

/**
 * テスト結果インターフェース
 */
interface TestResult {
  config: TestConfig;
  rtts: number[];    // 往復時間 (ms)
  avgRtt: number;    // 平均往復時間 (ms)
  minRtt: number;    // 最小往復時間 (ms)
  maxRtt: number;    // 最大往復時間 (ms)
  medianRtt: number; // 中央値往復時間 (ms)
  throughput: number; // スループット (Mbps)
  dataErrors: number; // データ整合性エラー数
}

/**
 * 指定されたサイズのデータを使用したベンチマークテストを実行します
 */
async function runSizeTest(config: TestConfig): Promise<TestResult> {
  console.log(`\n---- ${config.name} (${config.size} bytes) テスト開始 ----`);
  
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
  
  // DataChannel作成
  const dc1 = peer1.createDataChannel("benchmark");
  let dc2: Werift.RTCDataChannel;
  
  // DataChannelの受信設定
  peer2.onDataChannel.subscribe((channel) => {
    dc2 = channel;
    
    // エコーサーバーとして機能（受信データをそのまま送り返す）
    channel.onMessage.subscribe((msg) => {
      channel.send(msg);
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
  
  // テストデータ
  const testData = randomBytes(config.size);
  const results: number[] = [];
  let dataErrors = 0;
  
  // 往復時間(RTT)テスト
  for (let i = 0; i < config.iterations; i++) {
    const start = performance.now();
    
    // メッセージを送信
    dc1.send(testData);
    
    // 応答を待機して内容を検証
    await new Promise<void>((resolve) => {
      dc1.onMessage.once((receivedData) => {
        const end = performance.now();
        
        // データの完全性チェック
        if (Buffer.isBuffer(receivedData)) {
          // Bufferの場合はバイト単位で比較
          if (testData.length !== receivedData.length || !testData.equals(receivedData)) {
            console.warn(`${config.name}: データ整合性エラー（テスト ${i}）`);
            console.warn(`  送信サイズ: ${testData.length}, 受信サイズ: ${receivedData.length}`);
            dataErrors++;
          }
        } else if (typeof receivedData === 'string') {
          // 文字列の場合は変換してから比較
          const testDataStr = testData.toString();
          if (testDataStr !== receivedData) {
            console.warn(`${config.name}: データ整合性エラー（テスト ${i}）`);
            dataErrors++;
          }
        }
        
        results.push(end - start);
        resolve();
      });
    });
    
    // 進捗表示
    if (i % Math.max(1, Math.floor(config.iterations / 10)) === 0) {
      console.log(`${config.name}: テスト進捗 ${i}/${config.iterations}`);
    }
  }
  
  // 結果集計
  const avg = results.reduce((sum, val) => sum + val, 0) / results.length;
  const min = Math.min(...results);
  const max = Math.max(...results);
  const sorted = [...results].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  
  // スループット計算 (Mbps)
  // データは往復するため、サイズ×2
  const throughput = ((config.size * 8 * 2) / (avg / 1000)) / 1_000_000;
  
  // 結果出力
  console.log(`\n---- ${config.name} 結果 ----`);
  console.log(`サンプル数: ${results.length}`);
  console.log(`データサイズ: ${formatBytes(config.size)}`);
  console.log(`平均RTT: ${avg.toFixed(2)}ms`);
  console.log(`最小RTT: ${min.toFixed(2)}ms`);
  console.log(`最大RTT: ${max.toFixed(2)}ms`);
  console.log(`中央値RTT: ${median.toFixed(2)}ms`);
  console.log(`スループット: ${throughput.toFixed(2)} Mbps`);
  console.log(`データ整合性エラー数: ${dataErrors}`);
  
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
    dataErrors
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
  console.log("DataChannel サイズベンチマークを開始します...");
  
  // テスト設定
  const configs: TestConfig[] = [
    { name: "小サイズ", size: 1 * 1024, iterations: 50 },        // 1 KB
    { name: "中サイズ", size: 10 * 1024, iterations: 30 },       // 10 KB
    { name: "大サイズ", size: 100 * 1024, iterations: 20 },      // 100 KB
    { name: "超大サイズ", size: 1 * 1024 * 1024, iterations: 10 } // 1 MB
  ];
  
  // 各サイズでテスト実行
  const results: TestResult[] = [];
  for (const config of configs) {
    const result = await runSizeTest(config);
    results.push(result);
  }
  
  // 最終結果の表示
  console.log("\n========== 最終結果 ==========");
  console.table(results.map(r => ({
    "テスト名": r.config.name,
    "サイズ": formatBytes(r.config.size),
    "平均RTT (ms)": r.avgRtt.toFixed(2),
    "中央値RTT (ms)": r.medianRtt.toFixed(2),
    "スループット (Mbps)": r.throughput.toFixed(2),
    "データエラー": r.dataErrors
  })));
  
  // CSVフォーマットでも出力（ファイル出力やグラフ化が容易）
  console.log("\nCSVフォーマット:");
  console.log("テスト名,サイズ(bytes),平均RTT(ms),中央値RTT(ms),最小RTT(ms),最大RTT(ms),スループット(Mbps),データエラー数");
  for (const r of results) {
    console.log(`${r.config.name},${r.config.size},${r.avgRtt.toFixed(2)},${r.medianRtt.toFixed(2)},${r.minRtt.toFixed(2)},${r.maxRtt.toFixed(2)},${r.throughput.toFixed(2)},${r.dataErrors}`);
  }
  
  return results;
}

// ベンチマークを実行
runBenchmark().catch((err) => {
  console.error("エラーが発生しました:", err);
});
