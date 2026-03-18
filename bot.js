/**
 * NQ ICT Trading Bot — Node.js
 * Data Source: Twelve Data (free tier) — NAS100 / US100 CFD
 * Strategy:    4H/Daily swing highs/lows sweep → 15min CISD + FVG confirmation
 * Alerts:      Telegram ONLY
 * Schedule:    Every 5 minutes, 1:00 AM – 11:00 AM EST only
 */

require("dotenv").config();
const cron         = require("node-cron");
const axios        = require("axios");
const { DateTime } = require("luxon");

// ─── ENV VARIABLES ─────────────────────────────────────────────────────────────
const {
  TWELVEDATA_API_KEY,
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
} = process.env;

// ─── BOT SETTINGS ──────────────────────────────────────────────────────────────
const SYMBOL         = "NAS100";   // Twelve Data symbol for NQ / Nasdaq 100 CFD
const EXCHANGE       = "CFD";      // CFD exchange on Twelve Data

const SWEEP_THRESH   = 0.0005;     // 0.05% — how far beyond level = confirmed sweep
const FVG_MIN_SIZE   = 5.0;        // Minimum FVG size in points
const CISD_LOOKBACK  = 10;         // Number of 15min candles to check for CISD
const ALERT_COOLDOWN = 2 * 60 * 60 * 1000; // 2 hours — prevents duplicate alerts

// Trading window (EST)
const SESSION_START  = 1;   // 1:00 AM EST
const SESSION_END    = 11;  // 11:00 AM EST

const lastAlertTimes = {};  // Track last alert per level to avoid spam

// ─── TWELVE DATA — FETCH CANDLES ───────────────────────────────────────────────
/**
 * Fetch OHLCV candles from Twelve Data
 * @param {string} interval   - e.g. "4h", "1day", "15min"
 * @param {number} outputsize - number of candles to fetch
 */
async function getCandles(interval, outputsize = 100) {
  const url = "https://api.twelvedata.com/time_series";
  const params = {
    symbol:      SYMBOL,
    exchange:    EXCHANGE,
    interval,
    outputsize,
    order:       "ASC",       // oldest → newest
    apikey:      TWELVEDATA_API_KEY,
  };

  const { data } = await axios.get(url, { params, timeout: 15000 });

  // Check for API errors
  if (data.status === "error") {
    throw new Error(`Twelve Data error: ${data.message}`);
  }

  const values = data.values || [];
  if (!values.length) throw new Error(`No candles returned for interval: ${interval}`);

  return values.map((r) => ({
    time:   new Date(r.datetime),
    open:   parseFloat(r.open),
    high:   parseFloat(r.high),
    low:    parseFloat(r.low),
    close:  parseFloat(r.close),
    volume: parseFloat(r.volume || 0),
  }));
}

// ─── SWING LEVEL DETECTION ─────────────────────────────────────────────────────
/**
 * Find the most recent swing high and swing low from candles
 * A swing high = higher than `lookback` candles on both sides
 */
function getSwingLevels(candles, lookback = 5) {
  const swingHighs = [];
  const swingLows  = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const isHigh = [...Array(lookback)].every(
      (_, j) =>
        candles[i].high > candles[i - j - 1].high &&
        candles[i].high > candles[i + j + 1].high
    );
    const isLow = [...Array(lookback)].every(
      (_, j) =>
        candles[i].low < candles[i - j - 1].low &&
        candles[i].low < candles[i + j + 1].low
    );

    if (isHigh) swingHighs.push({ time: candles[i].time, price: candles[i].high });
    if (isLow)  swingLows.push({  time: candles[i].time, price: candles[i].low  });
  }

  const levels = {};
  if (swingHighs.length) levels.swing_high = swingHighs.at(-1); // most recent
  if (swingLows.length)  levels.swing_low  = swingLows.at(-1);
  return levels;
}

/**
 * Get the previous day's high and low as key levels
 */
function getDailyExtremes(dailyCandles) {
  if (dailyCandles.length < 2) return {};
  const prev = dailyCandles.at(-2); // second to last = previous completed day
  return {
    daily_high: { time: prev.time, price: prev.high },
    daily_low:  { time: prev.time, price: prev.low  },
  };
}

// ─── SWEEP DETECTION ───────────────────────────────────────────────────────────
/**
 * Returns true if price has swept beyond the level by SWEEP_THRESH
 * direction: "above" for highs, "below" for lows
 */
function detectSweep(currentPrice, levelPrice, direction) {
  if (direction === "above") return currentPrice > levelPrice * (1 + SWEEP_THRESH);
  return currentPrice < levelPrice * (1 - SWEEP_THRESH);
}

// ─── FVG DETECTION (Fair Value Gap) ────────────────────────────────────────────
/**
 * Bullish FVG: gap between candle[i-2].high and candle[i].low
 * Bearish FVG: gap between candle[i].high and candle[i-2].low
 * Returns last 5 FVGs found
 */
function detectFVG(candles) {
  const fvgs = [];

  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i - 2];
    const c2 = candles[i];

    // Bullish FVG — gap up
    if (c2.low > c0.high && (c2.low - c0.high) >= FVG_MIN_SIZE) {
      fvgs.push({
        type:   "bullish",
        top:    c2.low,
        bottom: c0.high,
        time:   c2.time,
        size:   c2.low - c0.high,
      });
    }

    // Bearish FVG — gap down
    if (c0.low > c2.high && (c0.low - c2.high) >= FVG_MIN_SIZE) {
      fvgs.push({
        type:   "bearish",
        top:    c0.low,
        bottom: c2.high,
        time:   c2.time,
        size:   c0.low - c2.high,
      });
    }
  }

  return fvgs.slice(-5); // keep last 5 FVGs only
}

/**
 * Check if current price is inside an FVG of the expected type
 */
function priceInFVG(price, fvgs, type) {
  return [...fvgs].reverse().find(
    (f) => f.type === type && price >= f.bottom && price <= f.top
  ) || null;
}

// ─── CISD DETECTION (Change In State of Delivery) ─────────────────────────────
/**
 * Bullish CISD: After a low sweep, look for a strong bullish candle
 *               that closes ABOVE the previous swing high (structure break)
 * Bearish CISD: After a high sweep, look for a strong bearish candle
 *               that closes BELOW the previous swing low (structure break)
 * "Strong" = body is > 60% of the full candle range (displacement)
 */
function detectCISD(candles, bias) {
  const recent = candles.slice(-CISD_LOOKBACK);
  if (recent.length < 4) return false;

  for (let i = 2; i < recent.length; i++) {
    const c      = recent[i];
    const before = recent.slice(0, i);

    if (bias === "bullish") {
      const prevHigh = Math.max(...before.map((x) => x.high));
      const body     = c.close - c.open;
      const full     = c.high  - c.low  || 1;
      if (c.close > prevHigh && body > 0 && body / full > 0.6) return true;
    }

    if (bias === "bearish") {
      const prevLow = Math.min(...before.map((x) => x.low));
      const body    = c.open  - c.close;
      const full    = c.high  - c.low  || 1;
      if (c.close < prevLow && body > 0 && body / full > 0.6) return true;
    }
  }

  return false;
}

// ─── ALERT: TELEGRAM ───────────────────────────────────────────────────────────
async function sendTelegram(message) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" },
      { timeout: 10000 }
    );
    console.log("  ✅ Telegram sent");
  } catch (e) {
    console.error("  ❌ Telegram failed:", e.message);
  }
}

// ─── FIRE ALERT ────────────────────────────────────────────────────────────────
async function fireAlert(title, details) {
  const nowUTC = DateTime.utc().toFormat("yyyy-MM-dd HH:mm");

  const tgMsg = [
    `<b>🚨 NQ ICT SETUP DETECTED</b>`,
    `<b>${title}</b>`,
    ``,
    `<pre>${details}</pre>`,
    `<i>⏰ ${nowUTC} UTC</i>`,
  ].join("\n");

  await sendTelegram(tgMsg);
}

// ─── MAIN SCAN ─────────────────────────────────────────────────────────────────
async function scan() {
  const nowEST = DateTime.now().setZone("America/New_York");
  const hour   = nowEST.hour;

  // ─ Time window check ─
  if (hour < SESSION_START || hour >= SESSION_END) {
    console.log(`⏸  [${nowEST.toFormat("HH:mm")} EST] Outside session (${SESSION_START}AM–${SESSION_END}AM) — sleeping`);
    return;
  }

  console.log(`\n${"─".repeat(55)}`);
  console.log(`🔍  NQ Scan @ ${nowEST.toFormat("HH:mm")} EST`);
  console.log(`${"─".repeat(55)}`);

  try {
    // ─ Fetch all timeframes in parallel ─
    const [candles4H, candlesDaily, candles15] = await Promise.all([
      getCandles("4h",   100),   // 4-hour candles — swing levels
      getCandles("1day",  20),   // daily candles  — prev day high/low
      getCandles("15min", 50),   // 15-min candles — CISD + FVG
    ]);

    // ─ Current price ─
    const currentPrice = candles15.at(-1).close;
    console.log(`📊  NAS100 Price : ${currentPrice.toFixed(2)}`);

    // ─ Build key levels ─
    const swingLevels = getSwingLevels(candles4H, 5);
    const dailyLevels = getDailyExtremes(candlesDaily);
    const allLevels   = { ...swingLevels, ...dailyLevels };

    console.log(`📍  Key Levels   :`);
    for (const [k, v] of Object.entries(allLevels)) {
      console.log(`    ${k.padEnd(12)} → ${v.price.toFixed(2)}`);
    }

    // ─ Detect FVGs on 15min ─
    const fvgs = detectFVG(candles15);
    console.log(`📦  FVGs found   : ${fvgs.length}`);

    // ─ Check each level for sweep + confirmation ─
    let setupFound = false;

    for (const [levelName, { price: levelPrice }] of Object.entries(allLevels)) {
      const isHigh   = levelName.includes("high");
      const sweepDir = isHigh ? "above" : "below";
      const swept    = detectSweep(currentPrice, levelPrice, sweepDir);

      if (!swept) continue;

      setupFound = true;
      console.log(`\n⚡  SWEEP: ${levelName} @ ${levelPrice.toFixed(2)}`);

      const bias     = isHigh ? "bearish" : "bullish";
      const fvgType  = isHigh ? "bearish" : "bullish";

      const cisdOK   = detectCISD(candles15, bias);
      const fvgMatch = priceInFVG(currentPrice, fvgs, fvgType);

      console.log(`    CISD (${bias})  : ${cisdOK   ? "✅ YES" : "❌ NO"}`);
      console.log(`    FVG  (${fvgType}) : ${fvgMatch ? "✅ YES" : "❌ NO"}`);

      if (!cisdOK && !fvgMatch) {
        console.log(`    → Sweep detected but no confirmation yet — watching`);
        continue;
      }

      // ─ Cooldown: don't re-alert same level within 2 hours ─
      const key      = `${levelName}_${Math.round(levelPrice)}`;
      const lastTime = lastAlertTimes[key] || 0;

      if (Date.now() - lastTime < ALERT_COOLDOWN) {
        const remaining = Math.round((ALERT_COOLDOWN - (Date.now() - lastTime)) / 60000);
        console.log(`    → Cooldown active (${remaining} mins left) — skipping alert`);
        continue;
      }

      lastAlertTimes[key] = Date.now();

      // ─ Build alert message ─
      const label   = levelName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const title   = `${bias.toUpperCase()} REVERSAL — ${label} Swept`;

      const fvgLine = fvgMatch
        ? `FVG Range  : ${fvgMatch.bottom.toFixed(2)} – ${fvgMatch.top.toFixed(2)} (${fvgMatch.size.toFixed(1)} pts)`
        : "";

      const details = [
        `Instrument : NAS100 (NQ CFD)`,
        `Level      : ${label} @ ${levelPrice.toFixed(2)}`,
        `Price      : ${currentPrice.toFixed(2)}`,
        `Bias       : ${bias.toUpperCase()}`,
        ``,
        `CISD       : ${cisdOK   ? "✅ Confirmed"    : "❌ Not confirmed"}`,
        `FVG        : ${fvgMatch ? "✅ Price in FVG" : "❌ Not in FVG"}`,
        fvgLine,
        ``,
        `Time (EST) : ${nowEST.toFormat("yyyy-MM-dd HH:mm")}`,
      ].filter((l) => l !== undefined).join("\n");

      console.log(`\n🚨  ALERT FIRING → ${title}`);
      await fireAlert(title, details);
    }

    if (!setupFound) {
      console.log(`✅  No sweeps detected — levels holding`);
    }

  } catch (err) {
    console.error(`\n❌  Scan error: ${err.message}`);
    if (err.response) {
      console.error(`    API response:`, JSON.stringify(err.response.data, null, 2));
    }
  }

  console.log(`${"─".repeat(55)}\n`);
}

// ─── STARTUP ───────────────────────────────────────────────────────────────────
console.log("╔═══════════════════════════════════════════╗");
console.log("║       🤖  NQ ICT TRADING BOT              ║");
console.log("║       Data: Twelve Data (NAS100 CFD)      ║");
console.log("║       Alerts: Telegram                    ║");
console.log("║       Scan: Every 5 minutes               ║");
console.log("║       Window: 1:00 AM – 11:00 AM EST      ║");
console.log("╚═══════════════════════════════════════════╝\n");

// Run once immediately on start
scan();

// Then every 5 minutes
cron.schedule("*/5 * * * *", scan);
