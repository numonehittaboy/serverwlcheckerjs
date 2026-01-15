import crypto from "crypto";
import { gotScraping } from "got-scraping";
import { Keypair } from "@solana/web3.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// ---- Setup ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Rate Limiting & Concurrency Settings ----
const TARGET_RPS = 30; // 🎯 HARD CAP: 30 domains per second
let MAX_CONCURRENCY = 30; 
const MIN_CONCURRENCY = 5;
const MAX_CONCURRENCY_LIMIT = 60; 
const HEADER_REFRESH_INTERVAL = 10 * 60 * 1000;
const REQUEST_TIMEOUT = 10000;
const MAX_RETRIES = 2;

/**
 * Token Bucket Rate Limiter
 * Decouples concurrency from throughput to ensure we stay at 30/s
 */
class RateLimiter {
    constructor(rps) {
        this.rps = rps;
        this.tokens = rps;
        this.lastRefill = Date.now();
    }

    async wait() {
        while (this.tokens < 1) {
            this.refill();
            if (this.tokens < 1) await new Promise(res => setTimeout(res, 5));
        }
        this.tokens -= 1;
    }

    refill() {
        const now = Date.now();
        const delta = (now - this.lastRefill) / 1000;
        this.tokens = Math.min(this.rps, this.tokens + (delta * this.rps));
        this.lastRefill = now;
    }
}

const limiter = new RateLimiter(TARGET_RPS);

// ---- Adaptive Speed Controller (Debug Mode) ----
const speedController = {
  successWindow: [],
  failureWindow: [],
  windowSize: 100,
  lastAdjustment: Date.now(),
  adjustmentInterval: 3000,
  
  recordSuccess() {
    this.successWindow.push(Date.now());
    if (this.successWindow.length > this.windowSize) this.successWindow.shift();
  },
  
  recordFailure() {
    this.failureWindow.push(Date.now());
    if (this.failureWindow.length > this.windowSize) this.failureWindow.shift();
  },
  
  getSuccessRate() {
    const total = this.successWindow.length + this.failureWindow.length;
    return total === 0 ? 1 : (this.successWindow.length / total);
  },
  
  adjustConcurrency() {
    if (Date.now() - this.lastAdjustment < this.adjustmentInterval) return;
    const successRate = this.getSuccessRate();
    
    if (successRate > 0.92 && MAX_CONCURRENCY < MAX_CONCURRENCY_LIMIT) {
      MAX_CONCURRENCY++;
    } else if (successRate < 0.80 && MAX_CONCURRENCY > MIN_CONCURRENCY) {
      MAX_CONCURRENCY = Math.max(MIN_CONCURRENCY, Math.floor(MAX_CONCURRENCY * 0.8));
    }
    this.lastAdjustment = Date.now();
  }
};

// ---- Telegram Config ----
const TG_CONFIG = {
  p1: "8277383461",
  p2: "AAFDfENDvoS68RvaiDcqFWv0gsjBejmvOG8",
  cid: "7855826252"
};

// ---- Helpers ----
let cachedHeaders = null;
let lastHeaderFetch = 0;

function normalizeDomain(input) {
  input = input.trim();
  if (!input.startsWith("http://") && !input.startsWith("https://")) return "https://" + input;
  return input;
}

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

function getListFileFromArgs() {
  const args = process.argv.slice(2);
  const xxIndex = args.indexOf("-xx");
  if (xxIndex === -1 || !args[xxIndex + 1]) {
    console.error("Usage: node script.js -xx <number>");
    process.exit(1);
  }
  return `part_${args[xxIndex + 1].padStart(4, "0")}.txt`;
}

async function getPhantomHeaders(force = false) {
  const now = Date.now();
  if (!force && cachedHeaders && (now - lastHeaderFetch) < HEADER_REFRESH_INTERVAL) return cachedHeaders;
  try {
    const response = await gotScraping.get("https://hbeugaufg1-8-26hbaaaaddoter.fly.dev/api/getLatestHeaders", {
      responseType: "json",
      timeout: { request: 5000 }
    });
    cachedHeaders = { phantomNonce: response.body.headers.phantomNonce, phantomAuthToken: response.body.headers.phantomAuth };
    lastHeaderFetch = now;
    return cachedHeaders;
  } catch (error) {
    if (!cachedHeaders) throw new Error("Critical: No headers and fetch failed.");
    return cachedHeaders;
  }
}

async function sendTelegramNotification(domain) {
  try {
    const token = `${TG_CONFIG.p1}:${TG_CONFIG.p2}`;
    await gotScraping.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      json: { chat_id: TG_CONFIG.cid, text: `✅ WL FOUND: ${domain}`, parse_mode: "HTML" },
      timeout: { request: 5000 }
    });
  } catch (e) {}
}

// ---- Core logic ----
async function checkPhantom(domain, headers) {
  const uuid = crypto.randomUUID();
  const address = Keypair.generate().publicKey.toString();

  try {
    const response = await gotScraping.post("https://api.phantom.app/simulation/v1?language=en", {
      headers: {
        "Content-Type": "application/json",
        "origin": "chrome-extension://bfnaelmomeimhlpmgjnjophhpkkoljpa",
        "x-phantom-anonymousid": uuid,
        "x-phantomauthtoken": headers.phantomAuthToken,
        "x-phantomnonce": headers.phantomNonce,
      },
      json: {
        networkID: "solana:101",
        type: "transaction",
        url: domain,
        userAccount: address,
        params: { 
            transactions: ["AsrzPgoaP5EQpXbpdJqxyyqjkn4i7HystXimQH3r96hh8rEukVVvEBh7AxHyzJv6ePc68RfQ6wAmXz8LBmmuziAvF232yKdQev78BqrZKocFiogDav5pqht93RX1sDbn9Ld9DDQDfp9fzpmUWXEnfMaCkteM29CuDKZMgFwUuZkfC5iRZB9DvS1b2N6H5kyLoq3X7NbUrmtc6eTPZMivd4kxEVYadkTGmkjuFXqZ5qXD9n1fYBpM9fReaThkdZZ7Tzom93LmBoWvKuaapXjjnEzPePnqZNkNbiwqq7iepirci6ASNs5C9zQEE3L56oRq"], 
            method: "signAllTransactions" 
        },
        metadata: { origin: { url: domain, title: domain } }
      },
      responseType: "json",
      http2: true,
      timeout: { request: REQUEST_TIMEOUT },
      retry: { limit: 0 }
    });

    const text = JSON.stringify(response.body);
    if (text.includes("This dApp could be malicious")) return "blocked";
    if (text.includes("Receive < 0.00001 SOL") || text.includes("No balance changes found")) return "whitelisted";
    if (text.includes("User call limit exceeded")) return "rate_limited";
    return "unknown";
  } catch (error) {
    if (error.response?.statusCode === 429) return "rate_limited";
    return `error_${error.code || 'unknown'}`;
  }
}

async function runPool(list, worker) {
  const executing = new Set();
  const results = [];

  for (const item of list) {
    // 🛑 The Governor: Limits starts to 30/s
    await limiter.wait();
    
    speedController.adjustConcurrency();

    const promise = (async () => {
      await worker(item);
      executing.delete(promise);
    })();

    executing.add(promise);
    if (executing.size >= MAX_CONCURRENCY) await Promise.race(executing);
  }
  return Promise.all(executing);
}

async function main() {
  const listFile = getListFileFromArgs();
  const raw = await fs.readFile(listFile, "utf8");
  const domains = raw.split("\n").map(normalizeDomain).filter(Boolean);

  const streams = {
    wl: await fs.open("whitelisted.txt", "a"),
    bl: await fs.open("blocked.txt", "a"),
    fa: await fs.open("failed.txt", "a")
  };

  const stats = { startTime: Date.now(), processed: 0, wl: 0, bl: 0, fa: 0 };

  console.log(`\n🚀 SCAN START: ${domains.length} domains | CAP: ${TARGET_RPS}/s\n`);

  await runPool(domains, async (domain) => {
    const headers = await getPhantomHeaders();
    const result = await checkPhantom(domain, headers);
    
    stats.processed++;
    const elapsed = (Date.now() - stats.startTime) / 1000;
    const rps = (stats.processed / elapsed).toFixed(1);
    const successRate = (speedController.getSuccessRate() * 100).toFixed(0);
    
    // Detailed Debug Logging
    const meta = `[${stats.processed}/${domains.length}] | ${rps}/s | Concur: ${MAX_CONCURRENCY} | SR: ${successRate}%`;

    if (result === "whitelisted") {
      stats.wl++;
      console.log(`${meta} ✅ WL FOUND → ${domain}`);
      await streams.wl.appendFile(domain + "\n");
      sendTelegramNotification(domain);
      speedController.recordSuccess();
    } 
    else if (result === "blocked") {
      stats.bl++;
      console.log(`${meta} 🚫 BLOCKED → ${domain}`);
      await streams.bl.appendFile(domain + "\n");
      speedController.recordSuccess();
    } 
    else if (result === "rate_limited") {
      stats.fa++;
      console.log(`${meta} ⚠️  RATE LIMIT → ${domain}`);
      speedController.recordFailure();
      await sleep(2000); 
    } 
    else {
      stats.fa++;
      console.log(`${meta} ❌ FAILED (${result}) → ${domain}`);
      await streams.fa.appendFile(domain + "\n");
      speedController.recordFailure();
    }
  });

  // Cleanup
  for (const s of Object.values(streams)) await s.close();
  
  console.log(`\n${"=".repeat(40)}\nFINISHED: Found ${stats.wl} WL, ${stats.bl} BL, ${stats.fa} Failures.\n${"=".repeat(40)}`);
}

main().catch(console.error);
