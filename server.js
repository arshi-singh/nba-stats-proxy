import express from "express";
import axios from "axios";
import https from "https";

const app = express();

/**
 * Shared HTTPS agent
 * keepAlive helps avoid repeated TLS handshakes.
 */
const httpsAgent = new https.Agent({ keepAlive: true });

/**
 * CORS helpers (so you can test from browser / Supabase easily)
 */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

app.options("*", (_req, res) => {
  setCors(res);
  res.status(204).send();
});

/**
 * Health check
 */
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "nba-stats-proxy" });
});

/**
 * General outbound connectivity probe
 * Confirms Railway can reach public internet + nba.com + attempts stats.nba.com (minimal headers).
 */
app.get("/probe", async (_req, res) => {
  const targets = [
    "https://www.google.com",
    "https://www.nba.com",
    "https://stats.nba.com/stats/leaguedashteamstats?LeagueID=00&Season=2024-25&SeasonType=Regular%20Season&PerMode=Totals&MeasureType=Base"
  ];

  const results = [];

  for (const url of targets) {
    try {
      const r = await axios.get(url, {
        httpsAgent,
        timeout: 15000,
        decompress: true,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/json;q=0.9,*/*;q=0.8"
        },
        validateStatus: () => true
      });

      results.push({
        url,
        ok: true,
        status: r.status,
        contentType: r.headers["content-type"] ?? null
      });
    } catch (e) {
      results.push({
        url,
        ok: false,
        error: e?.message ?? String(e),
        code: e?.code ?? null
      });
    }
  }

  res.json({ ok: true, results });
});

/**
 * NBA-specific probe with STRICT headers.
 * This isolates whether stats.nba.com responds when the request looks like nba.com.
 * Returns a small summary so you don't have to scroll huge JSON.
 */
app.get("/probe-nba", async (_req, res) => {
  const testUrl =
    "https://stats.nba.com/stats/leaguedashteamstats?LeagueID=00&Season=2024-25&SeasonType=Regular%20Season&PerMode=Totals&MeasureType=Base";

  try {
    const r = await axios.get(testUrl, {
      httpsAgent,
      timeout: 30000,
      decompress: true,
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Origin": "https://www.nba.com",
        "Referer": "https://www.nba.com/stats/teams/traditional",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "x-nba-stats-origin": "stats",
        "x-nba-stats-token": "true",
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty"
      },
      validateStatus: () => true
    });

    setCors(res);

    const data = r.data;
    const firstHeaders =
      data?.resultSets?.[0]?.headers?.slice?.(0, 12) ??
      data?.resultSet?.headers?.slice?.(0, 12) ??
      null;

    res.status(200).json({
      ok: true,
      status: r.status,
      contentType: r.headers["content-type"] ?? null,
      topLevelKeys: data ? Object.keys(data) : [],
      sampleHeaders: firstHeaders
    });
  } catch (e) {
    setCors(res);
    res.status(500).json({
      ok: false,
      error: e?.message ?? String(e),
      code: e?.code ?? null
    });
  }
});

/**
 * Main endpoint: NBA team stats (includes FGA, FG3A, FG3_PCT, etc.)
 * Query params:
 *  - season: "2025-26" (default)
 *  - seasonType: "Regular Season" (default)
 */
app.get("/nba/teamstats", async (req, res) => {
  const season = req.query.season ?? "2025-26";
  const seasonType = req.query.seasonType ?? "Regular Season";

  const nbaUrl = new URL("https://stats.nba.com/stats/leaguedashteamstats");
  nbaUrl.searchParams.set("Season", season);
  nbaUrl.searchParams.set("SeasonType", seasonType);
  nbaUrl.searchParams.set("LeagueID", "00");
  nbaUrl.searchParams.set("PerMode", "Totals");
  nbaUrl.searchParams.set("MeasureType", "Base");

  try {
    // 1) Prime cookies from nba.com (helps with some edge behaviors)
    const prime = await axios.get("https://www.nba.com", {
      httpsAgent,
      timeout: 20000,
      decompress: true,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      validateStatus: () => true
    });

    const setCookies = prime.headers["set-cookie"] || [];
    const cookieHeader = Array.isArray(setCookies)
      ? setCookies.map((c) => c.split(";")[0]).join("; ")
      : "";

    // 2) Call stats.nba.com with strict headers + cookies
    const nbaResp = await axios.get(nbaUrl.toString(), {
      httpsAgent,
      timeout: 45000,
      decompress: true,
      responseType: "arraybuffer",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Origin": "https://www.nba.com",
        "Referer": "https://www.nba.com/stats/teams/traditional",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "x-nba-stats-origin": "stats",
        "x-nba-stats-token": "true",
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        ...(cookieHeader ? { "Cookie": cookieHeader } : {})
      },
      validateStatus: () => true
    });

    // CORS
    setCors(res);

    const ct = (nbaResp.headers["content-type"] ?? "").toLowerCase();
    const rawText = Buffer.from(nbaResp.data || []).toString("utf8");
    const snippet = rawText.slice(0, 500);

    // If JSON, return it
    if (ct.includes("application/json") || snippet.trim().startsWith("{")) {
      try {
        const json = JSON.parse(rawText);
        return res.status(nbaResp.status).json(json);
      } catch {
        // Fall through to debug response if JSON parse fails
      }
    }

    // Otherwise return a debug payload so we can see what NBA is sending
    return res.status(502).json({
      ok: false,
      error: "Upstream did not return JSON",
      upstreamStatus: nbaResp.status,
      contentType: nbaResp.headers["content-type"] ?? null,
      headerKeys: Object.keys(nbaResp.headers || {}),
      primeStatus: prime.status,
      primeSetCookieCount: Array.isArray(setCookies) ? setCookies.length : 0,
      snippet
    });
  } catch (err) {
    setCors(res);
    return res.status(500).json({
      error: "NBA request failed",
      details: err?.message ?? String(err),
      code: err?.code ?? null
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
