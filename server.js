import express from "express";
import axios from "axios";
import https from "https";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";

const app = express();
const httpsAgent = new https.Agent({ keepAlive: true });

/**
 * One cookie jar per server instance.
 * NBA tends to require session cookies (anti-bot) to access stats endpoints.
 */
const jar = new CookieJar();

// Axios client with cookie jar support
const client = wrapper(
  axios.create({
    jar,
    withCredentials: true,
    httpsAgent,
    timeout: 30000,
    decompress: true,
    maxRedirects: 5,
    validateStatus: () => true
  })
);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

app.options("*", (_req, res) => {
  setCors(res);
  res.status(204).send();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "nba-stats-proxy" });
});

/**
 * Browser-like headers.
 * NOTE: We keep these stable and consistent across prime + stats requests.
 */
function baseBrowserHeaders() {
  return {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Connection": "keep-alive",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "sec-ch-ua": "\"Chromium\";v=\"120\", \"Not=A?Brand\";v=\"8\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty"
  };
}

/**
 * Prime cookies by visiting nba.com stats page.
 * This usually sets anti-bot cookies required before stats.nba.com responds.
 */
async function primeNbaCookies() {
  // Use an nba.com stats page as prime target
  const primeUrl = "https://www.nba.com/stats/teams/traditional";

  const r = await client.get(primeUrl, {
    headers: {
      ...baseBrowserHeaders(),
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    },
    responseType: "text"
  });

  // Return some diagnostics
  const setCookie = r.headers["set-cookie"] ?? [];
  return {
    primeStatus: r.status,
    primeSetCookieCount: Array.isArray(setCookie) ? setCookie.length : 0
  };
}

/**
 * Build full URL for leaguedashteamstats (team totals include FGA/FG3A/etc.)
 */
function buildLeagueDashTeamStatsUrl({ season, seasonType }) {
  const u = new URL("https://stats.nba.com/stats/leaguedashteamstats");

  // Core
  u.searchParams.set("LeagueID", "00");
  u.searchParams.set("Season", season);
  u.searchParams.set("SeasonType", seasonType);

  // Common
  u.searchParams.set("PerMode", "Totals");
  u.searchParams.set("MeasureType", "Base");

  // Filters (send defaults like nba.com does)
  u.searchParams.set("Conference", "");
  u.searchParams.set("Division", "");
  u.searchParams.set("Location", "");
  u.searchParams.set("Outcome", "");
  u.searchParams.set("PORound", "0");
  u.searchParams.set("DateFrom", "");
  u.searchParams.set("DateTo", "");
  u.searchParams.set("OpponentTeamID", "0");
  u.searchParams.set("VsConference", "");
  u.searchParams.set("VsDivision", "");
  u.searchParams.set("TeamID", "0");

  // Segment/time
  u.searchParams.set("GameSegment", "");
  u.searchParams.set("Period", "0");
  u.searchParams.set("LastNGames", "0");
  u.searchParams.set("Month", "0");
  u.searchParams.set("SeasonSegment", "");
  u.searchParams.set("ShotClockRange", "");
  u.searchParams.set("GameScope", "");
  u.searchParams.set("PlayerExperience", "");
  u.searchParams.set("PlayerPosition", "");
  u.searchParams.set("StarterBench", "");

  // Often present flags
  u.searchParams.set("PlusMinus", "N");
  u.searchParams.set("PaceAdjust", "N");
  u.searchParams.set("Rank", "N");

  return u;
}

/**
 * Stats headers (NBA checks origin/referrer + x-nba headers)
 */
function statsHeaders() {
  return {
    ...baseBrowserHeaders(),
    "Origin": "https://www.nba.com",
    "Referer": "https://www.nba.com/stats/teams/traditional",
    "x-nba-stats-origin": "stats",
    "x-nba-stats-token": "true"
  };
}

/**
 * Diagnostic endpoint: shows whether prime works and whether stats responds.
 */
app.get("/probe-nba", async (_req, res) => {
  setCors(res);

  const prime = await primeNbaCookies();

  const testUrl = buildLeagueDashTeamStatsUrl({
    season: "2024-25",
    seasonType: "Regular Season"
  });

  const upstream = await client.get(testUrl.toString(), {
    headers: statsHeaders(),
    responseType: "text"
  });

  const contentType = upstream.headers["content-type"] ?? null;

  // Attempt to parse JSON if it looks like JSON
  let parsed = null;
  if (typeof upstream.data === "string" && upstream.data.trim().startsWith("{")) {
    try {
      parsed = JSON.parse(upstream.data);
    } catch {
      parsed = null;
    }
  }

  // Return concise debug info
  if (parsed) {
    const sampleHeaders =
      parsed?.resultSets?.[0]?.headers?.slice?.(0, 12) ??
      parsed?.resultSet?.headers?.slice?.(0, 12) ??
      null;

    return res.json({
      ok: true,
      prime,
      upstreamStatus: upstream.status,
      contentType,
      topLevelKeys: Object.keys(parsed),
      sampleHeaders
    });
  }

  return res.json({
    ok: false,
    prime,
    upstreamStatus: upstream.status,
    contentType,
    headerKeys: Object.keys(upstream.headers || {}),
    snippet: typeof upstream.data === "string" ? upstream.data.slice(0, 800) : null
  });
});

/**
 * Main endpoint: returns NBA JSON (or returns readable snippet if blocked)
 * Query params:
 *  - season: default "2025-26"
 *  - seasonType: default "Regular Season"
 */
app.get("/nba/teamstats", async (req, res) => {
  setCors(res);

  const season = req.query.season ?? "2025-26";
  const seasonType = req.query.seasonType ?? "Regular Season";

  // Prime cookies first (cheap and helps with WAF)
  const prime = await primeNbaCookies();

  const nbaUrl = buildLeagueDashTeamStatsUrl({ season, seasonType });

  const upstream = await client.get(nbaUrl.toString(), {
    headers: statsHeaders(),
    responseType: "text"
  });

  const contentType = upstream.headers["content-type"] ?? null;

  if (typeof upstream.data === "string" && upstream.data.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(upstream.data);
      return res.status(upstream.status).json(parsed);
    } catch {
      // fall through
    }
  }

  // Not JSON — return debug payload so we can see why
  return res.status(502).json({
    ok: false,
    prime,
    upstreamStatus: upstream.status,
    contentType,
    headerKeys: Object.keys(upstream.headers || {}),
    snippet: typeof upstream.data === "string" ? upstream.data.slice(0, 1200) : null
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
