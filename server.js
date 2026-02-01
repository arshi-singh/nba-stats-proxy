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
    const nbaResp = await axios.get(nbaUrl.toString(), {
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

    // If NBA returns an HTML block page, this helps you see it quickly.
    const ct = (nbaResp.headers["content-type"] ?? "").toLowerCase();
    if (!ct.includes("application/json")) {
      return res.status(502).json({
        ok: false,
        error: "Unexpected content-type from stats.nba.com",
        status: nbaResp.status,
        contentType: nbaResp.headers["content-type"] ?? null,
        // Only include a small snippet to avoid huge HTML dumps
        snippet:
          typeof nbaResp.data === "string"
            ? nbaResp.data.slice(0, 400)
            : null
      });
    }

    // Pass through NBA JSON as-is
    res.status(nbaResp.status).json(nbaResp.data);
  } catch (err) {
    setCors(res);
    res.status(500).json({
      error: "NBA request failed",
      details: err?.message ?? String(err),
      code: err?.code ?? null
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
