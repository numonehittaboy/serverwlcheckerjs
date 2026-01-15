import crypto from "crypto";
import { gotScraping } from "got-scraping";
import { Keypair } from "@solana/web3.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// ---- Setup ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_CONCURRENCY = 50; // Increased for faster scanning
const HEADER_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes
const REQUEST_TIMEOUT = 8000; // 8 seconds timeout per request

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
        retry: { limit: 0 }, // No retries for speed
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
    // Check if it's a rate limit or server error
    if (error.response) {
      const statusCode = error.response.statusCode;
      if (statusCode === 429) return "rate_limited";
      if (statusCode >= 500) return "api_error";
    }
    return "error";
  }
}

// ---- Optimized Concurrency Pool ----
async function runPool(list, worker, limit) {
  const results = [];
  const executing = [];
  let index = 0;

  for (const item of list) {
    const promise = worker(item, index++).then(result => {
      executing.splice(executing.indexOf(promise), 1);
      return result;
    });

    results.push(promise);
    executing.push(promise);

    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// ---- Main ----
async function main() {
  // Initial header fetch
  let headers = await getPhantomHeaders(true);

  // Setup automatic header refresh every 10 minutes
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

  console.log(`🚀 Scanning ${domains.length} domains with ${MAX_CONCURRENCY} concurrent requests...\n`);

  const wlStream = await fs.open("whitelisted.txt", "a");
  const blockStream = await fs.open("blocked.txt", "a");
  const failedStream = await fs.open("failed.txt", "a");

  const startTime = Date.now();
  let processed = 0;
  let whitelisted = 0;
  let blocked = 0;
  let failed = 0;

  await runPool(domains, async (domain, index) => {
    const i = index + 1;
    
    // Always get current headers (will use cache if fresh)
    const currentHeaders = await getPhantomHeaders();
    const result = await checkPhantom(domain, currentHeaders);

    processed++;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = (processed / (Date.now() - startTime) * 1000).toFixed(1);

    if (["error", "rate_limited", "api_error"].includes(result)) {
      failed++;
      console.log(`[${i}/${domains.length}] ⚠ FAILED → ${domain} (${rate}/s)`);
      await failedStream.appendFile(domain + "\n");
      
      // Only sleep if rate limited
      if (result === "rate_limited") {
        await sleep(30000); // 10 second delay on rate limit
      }
      return;
    }

    if (result === "whitelisted") {
      whitelisted++;
      console.log(`[${i}/${domains.length}] ✅ WL → ${domain} (${rate}/s)`);
      await wlStream.appendFile(domain + "\n");
      // Send Telegram notification (non-blocking)
      sendTelegramNotification(domain).catch(() => {});
    } else if (result === "blocked") {
      blocked++;
      console.log(`[${i}/${domains.length}] 🚫 BLOCKED → ${domain} (${rate}/s)`);
      await blockStream.appendFile(domain + "\n");
    } else {
      console.log(`[${i}/${domains.length}] ⚪ ${result} → ${domain} (${rate}/s)`);
    }

  }, MAX_CONCURRENCY);

  // Cleanup
  clearInterval(headerRefreshTimer);
  await wlStream.close();
  await blockStream.close();
  await failedStream.close();

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const avgRate = (processed / (Date.now() - startTime) * 1000).toFixed(1);

  console.log("\n" + "=".repeat(60));
  console.log("✔ SCAN COMPLETE");
  console.log("=".repeat(60));
  console.log(`⏱️  Total time: ${totalTime}s`);
  console.log(`⚡ Average rate: ${avgRate} domains/second`);
  console.log(`📊 Processed: ${processed}/${domains.length}`);
  console.log(`✅ Whitelisted: ${whitelisted}`);
  console.log(`🚫 Blocked: ${blocked}`);
  console.log(`⚠️  Failed: ${failed}`);
  console.log("=".repeat(60));
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});

