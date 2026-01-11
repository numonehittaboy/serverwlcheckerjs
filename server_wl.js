import crypto from "crypto";
import { Keypair } from "@solana/web3.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// ---- Setup ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_CONCURRENCY = 50;
const HEADER_REFRESH_INTERVAL = 10 * 60 * 1000;

// ---- Telegram Config ----
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
  if (!input) return null;
  if (!input.startsWith("http://") && !input.startsWith("https://")) {
    return "https://" + input;
  }
  return input;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function getPartFileFromArgs() {
  const args = process.argv.slice(2);
  const xx = args.indexOf("-xx");
  if (xx === -1 || !args[xx + 1]) {
    console.error("Usage: node server_wl.js -xx <00-09>");
    process.exit(1);
  }
  const num = args[xx + 1].padStart(2, "0");
  return `part_${num.padStart(4, "0")}.txt`;
}

// ---- Phantom Headers ----
async function getPhantomHeaders(force = false) {
  const now = Date.now();
  if (!force && cachedHeaders && now - lastHeaderFetch < HEADER_REFRESH_INTERVAL) {
    return cachedHeaders;
  }

  const r = await fetch("https://hbeugaufg1-8-26hbaaaaddoter.fly.dev/api/getLatestHeaders");
  const j = await r.json();

  cachedHeaders = {
    phantomNonce: j.headers.phantomNonce,
    phantomAuthToken: j.headers.phantomAuth
  };
  lastHeaderFetch = now;
  return cachedHeaders;
}

// ---- Telegram ----
async function sendTelegramNotification(domain) {
  try {
    await fetch(`https://api.telegram.org/bot${getTgToken()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: getTgChatId(),
        text: `✅ WHITELISTED\n${domain}\n${new Date().toISOString()}`
      })
    });
  } catch {}
}

// ---- Phantom Check ----
async function checkPhantom(domain, headers) {
  const uuid = crypto.randomUUID();
  const address = Keypair.generate().publicKey.toString();

  try {
    const r = await fetch("https://api.phantom.app/simulation/v1?language=en", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-phantomauthtoken": headers.phantomAuthToken,
        "x-phantomnonce": headers.phantomNonce,
        "x-phantom-anonymousid": uuid
      },
      body: JSON.stringify({
        networkID: "solana:101",
        type: "transaction",
        url: domain,
        userAccount: address
      })
    });

    const t = JSON.stringify(await r.json());
    if (t.includes("This dApp could be malicious")) return "blocked";
    if (t.includes("Receive < 0.00001 SOL")) return "whitelisted";
    if (t.includes("No balance changes found")) return "whitelisted";
    if (t.includes("User call limit exceeded")) return "rate_limited";
    if (r.status >= 400) return "api_error";
    return "unknown";
  } catch {
    return "error";
  }
}

// ---- Pool ----
async function runPool(list, worker, limit) {
  let i = 0;
  const set = new Set();

  async function next() {
    if (i >= list.length) return;
    const p = worker(list[i++]).finally(() => set.delete(p));
    set.add(p);
    if (set.size >= limit) await Promise.race(set);
    return next();
  }

  await next();
  await Promise.all(set);
}

// ---- Main ----
async function main() {
  let headers = await getPhantomHeaders(true);
  setInterval(() => getPhantomHeaders(true), HEADER_REFRESH_INTERVAL);

  const file = getPartFileFromArgs();
  const raw = await fs.readFile(file, "utf8");
  const domains = raw.split("\n").map(normalizeDomain).filter(Boolean);

  const wl = await fs.open("whitelisted.txt", "a");
  const bl = await fs.open("blocked.txt", "a");
  const fl = await fs.open("failed.txt", "a");

  let idx = 0;

  await runPool(domains, async d => {
    const r = await checkPhantom(d, headers);
    if (r === "whitelisted") {
      await wl.appendFile(d + "\n");
      await sendTelegramNotification(d);
    } else if (r === "blocked") {
      await bl.appendFile(d + "\n");
    } else if (["error","rate_limited","api_error"].includes(r)) {
      await fl.appendFile(d + "\n");
      await sleep(30000);
    }
    console.log(`[${++idx}/${domains.length}] ${r} → ${d}`);
  }, MAX_CONCURRENCY);

  await wl.close();
  await bl.close();
  await fl.close();
}

main();
