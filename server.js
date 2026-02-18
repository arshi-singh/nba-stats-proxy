import express from "express";
import axios from "axios";
import https from "https";

const app = express();

/**
 * Shared HTTPS agent
 */
const httpsAgent = new https.Agent({ keepAlive: true });

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
 * ✅ NEW: Verify Railway env var is present (no key leakage)
 */
app.get("/debug/apikey", (_req, res) => {
  setCors(res);
  res.json({
    ok: true,
    hasKey: !!process.env.NBA_API_KEY,
    keyLength: process.env.NBA_API_KEY?.length ?? 0,
  });
});

/**
 * ✅ UPDATED: API-Sports game statistics probe
 * Fixes 403 "Missing application key" by:
 * - supporting both header styles (api-sports + rapidapi)
 * - returning a clearer error if NBA_API_KEY is not set
 */
function parseMinutesToInt(minStr) {
  // "240:00" -> 240
  if (!minStr) return null;
  const m = String(minStr).match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

app.get("/apisports/game-stats-normalized", async (req, res) => {
  setCors(res);

  const gameId = String(req.query.gameId || "").trim();
  const season = Number(req.query.season || 2024);

  if (!gameId) return res.status(400).json({ ok: false, error: "Missing gameId" });
  if (!process.env.NBA_API_KEY) {
    return res.status(500).json({ ok: false, error: "NBA_API_KEY missing in Railway env vars" });
  }

  try {
    const r = await axios.get("https://v2.nba.api-sports.io/games/statistics", {
      params: { id: gameId },
      headers: {
        "x-apisports-key": process.env.NBA_API_KEY,
        "x-apisports-host": "v2.nba.api-sports.io",
        "x-rapidapi-key": process.env.NBA_API_KEY,
        "x-rapidapi-host": "v2.nba.api-sports.io",
        "Accept": "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      timeout: 30000,
      validateStatus: () => true,
    });

    if (r.status >= 400) {
      return res.status(r.status).json({ ok: false, gameId, error: "API-Sports failed", upstream: r.data });
    }

    const items = r.data?.response;
    if (!Array.isArray(items) || items.length < 2) {
      return res.status(500).json({ ok: false, gameId, error: "Unexpected API-Sports response shape", upstream: r.data });
    }

    const rows = items.map((it) => {
  const s = it?.statistics?.[0] || {};

  return {
    game_id: String(gameId),
    season: Number.isFinite(season) ? season : 2024,

    // 🔥 ADD THESE TWO
    api_team_id: Number(it?.team?.id),
    team_code: String(it?.team?.code || "").trim(),

    min: parseMinutesToInt(s.min),
    pts: s.points ?? null,
    fgm: s.fgm ?? null,
    fga: s.fga ?? null,
    fg3m: s.tpm ?? null,
    fg3a: s.tpa ?? null,
    ftm: s.ftm ?? null,
    fta: s.fta ?? null,

    oreb: s.offReb ?? null,
    dreb: s.defReb ?? null,
    reb: s.totReb ?? null,

    ast: s.assists ?? null,
    tov: s.turnovers ?? null,
    stl: s.steals ?? null,
    blk: s.blocks ?? null,
    pf: s.pFouls ?? null,
    plus_minus: s.plusMinus != null ? Number(String(s.plusMinus)) : null,
  };
});

    res.json({ ok: true, gameId, rows });
  } catch (err) {
    res.status(500).json({
      ok: false,
      gameId,
      error: "API-Sports request failed",
      details: err?.message ?? String(err),
      code: err?.code ?? null,
    });
  }
});

app.get("/probe", async (_req, res) => {
  const targets = [
    "https://www.google.com",
    "https://www.nba.com",
    "https://stats.nba.com/stats/leaguedashteamstats?LeagueID=00&Season=2024-25&SeasonType=Regular%20Season&PerMode=Totals&MeasureType=Base",
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
          "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        },
        validateStatus: () => true,
      });

      results.push({
        url,
        ok: true,
        status: r.status,
        contentType: r.headers["content-type"] ?? null,
      });
    } catch (e) {
      results.push({
        url,
        ok: false,
        error: e?.message ?? String(e),
        code: e?.code ?? null,
      });
    }
  }

  res.json({ ok: true, results });
});

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
        "Host": "stats.nba.com",
        "Origin": "https://www.nba.com",
        "Referer": "https://www.nba.com/stats/teams/traditional",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "x-nba-stats-origin": "stats",
        "x-nba-stats-token": "true",
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      },
      validateStatus: () => true,
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
      sampleHeaders: firstHeaders,
    });
  } catch (e) {
    setCors(res);
    res.status(500).json({
      ok: false,
      error: e?.message ?? String(e),
      code: e?.code ?? null,
    });
  }
});

/**
 * Helpers for DateFrom/DateTo pass-through
 * NBA stats expects MM/DD/YYYY in DateFrom/DateTo.
 */
function pickQuery(req, ...keys) {
  for (const k of keys) {
    const v = req.query?.[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function isoToNbaDate(v) {
  if (!v) return "";
  const s = String(v).trim();

  // Already MM/DD/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;

  // Convert YYYY-MM-DD -> MM/DD/YYYY
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [, yyyy, mm, dd] = m;
    return `${mm}/${dd}/${yyyy}`;
  }

  // Unknown format: pass through (NBA may ignore, but we don't break)
  return s;
}

/**
 * Shared: prime cookies + fetch NBA JSON
 *
 * ✅ CHANGES:
 * - Cache cookies for 10 minutes (don’t prime on every request)
 * - Retry once on timeout, forcing a fresh cookie prime
 * - Allow per-route timeout override (teamdashboard uses longer timeout)
 */

// --- Cookie cache (global) ---
let cookieCache = {
  cookieHeader: "",
  fetchedAtMs: 0,
};
const COOKIE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function primeCookiesCached(force = false) {
  const now = Date.now();
  const fresh =
    cookieCache.cookieHeader && now - cookieCache.fetchedAtMs < COOKIE_TTL_MS;

  if (!force && fresh) {
    return { primeStatus: 200, cookieHeader: cookieCache.cookieHeader, cached: true };
  }

  const prime = await axios.get("https://www.nba.com", {
    httpsAgent,
    timeout: 20000,
    decompress: true,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    validateStatus: () => true,
  });

  const setCookies = prime.headers["set-cookie"] || [];
  const cookieHeader = Array.isArray(setCookies)
    ? setCookies.map((c) => c.split(";")[0]).join("; ")
    : "";

  cookieCache = {
    cookieHeader,
    fetchedAtMs: Date.now(),
  };

  return { primeStatus: prime.status, cookieHeader, cached: false };
}

async function fetchNbaJson(url, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs ?? 45000);
  const retryOnce = Boolean(opts.retryOnce ?? true);

  const runOnce = async (forcePrime = false) => {
    const { primeStatus, cookieHeader } = await primeCookiesCached(forcePrime);

    const nbaResp = await axios.get(url, {
      httpsAgent,
      timeout: timeoutMs,
      decompress: true,
      responseType: "arraybuffer",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Host": "stats.nba.com",
        "Origin": "https://www.nba.com",
        "Referer": "https://www.nba.com/stats/teams/traditional",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "x-nba-stats-origin": "stats",
        "x-nba-stats-token": "true",
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      validateStatus: () => true,
    });

    const ct = String(nbaResp.headers["content-type"] ?? "").toLowerCase();
    const rawText = Buffer.from(nbaResp.data || []).toString("utf8");
    const snippet = rawText.slice(0, 500);

    if (ct.includes("application/json") || snippet.trim().startsWith("{")) {
      try {
        const json = JSON.parse(rawText);
        return { ok: true, status: nbaResp.status, json, primeStatus };
      } catch {
        // fall through
      }
    }

    return {
      ok: false,
      status: 502,
      primeStatus,
      error: "Upstream did not return JSON",
      upstreamStatus: nbaResp.status,
      contentType: nbaResp.headers["content-type"] ?? null,
      snippet,
    };
  };

  try {
    return await runOnce(false);
  } catch (e) {
    const msg = String(e?.message ?? "");
    const isTimeout =
      e?.code === "ECONNABORTED" || msg.toLowerCase().includes("timeout");

    if (retryOnce && isTimeout) {
      try {
        // force fresh cookies and retry
        return await runOnce(true);
      } catch (e2) {
        return {
          ok: false,
          status: 500,
          error: "NBA request failed",
          details: e2?.message ?? String(e2),
          code: e2?.code ?? null,
        };
      }
    }

    return {
      ok: false,
      status: 500,
      error: "NBA request failed",
      details: e?.message ?? String(e),
      code: e?.code ?? null,
    };
  }
}

/**
 * ✅ /nba/teamstats (unchanged behavior)
 * Location + DateFrom/DateTo pass-through
 */
app.get("/nba/teamstats", async (req, res) => {
  const season = req.query.season ?? "2025-26";
  const seasonType = req.query.seasonType ?? "Regular Season";
  const measureType = req.query.measureType ?? "Base";
  const perMode = req.query.perMode ?? "Totals";

  // pass-through Location (or location)
  const rawLocation = String(req.query.Location ?? req.query.location ?? "").trim();
  const locationNorm = rawLocation
    ? rawLocation.charAt(0).toUpperCase() + rawLocation.slice(1).toLowerCase()
    : "";

  const allowedLocations = new Set(["", "Home", "Road", "Neutral"]);
  const locationFinal = allowedLocations.has(locationNorm) ? locationNorm : "";

  // DateFrom/DateTo pass-through (try multiple casings)
  const rawDateFrom = pickQuery(req, "DateFrom", "dateFrom");
  const rawDateTo = pickQuery(req, "DateTo", "dateTo");

  // Convert ISO -> MM/DD/YYYY for NBA
  const dateFromFinal = isoToNbaDate(rawDateFrom);
  const dateToFinal = isoToNbaDate(rawDateTo);

  const nbaUrl = new URL("https://stats.nba.com/stats/leaguedashteamstats");

  nbaUrl.searchParams.set("Season", season);
  nbaUrl.searchParams.set("SeasonType", seasonType);
  nbaUrl.searchParams.set("LeagueID", "00");

  nbaUrl.searchParams.set("PerMode", perMode);
  nbaUrl.searchParams.set("MeasureType", measureType);

  nbaUrl.searchParams.set("PlusMinus", "N");
  nbaUrl.searchParams.set("PaceAdjust", "N");
  nbaUrl.searchParams.set("Rank", "N");

  nbaUrl.searchParams.set("PORound", "0");
  nbaUrl.searchParams.set("Month", "0");
  nbaUrl.searchParams.set("OpponentTeamID", "0");
  nbaUrl.searchParams.set("TeamID", "0");
  nbaUrl.searchParams.set("Period", "0");
  nbaUrl.searchParams.set("LastNGames", "0");

  nbaUrl.searchParams.set("Conference", "");
  nbaUrl.searchParams.set("Division", "");
  nbaUrl.searchParams.set("Location", locationFinal);

  nbaUrl.searchParams.set("Outcome", "");
  nbaUrl.searchParams.set("SeasonSegment", "");

  nbaUrl.searchParams.set("DateFrom", dateFromFinal);
  nbaUrl.searchParams.set("DateTo", dateToFinal);

  nbaUrl.searchParams.set("GameSegment", "");
  nbaUrl.searchParams.set("ShotClockRange", "");
  nbaUrl.searchParams.set("GameScope", "");
  nbaUrl.searchParams.set("PlayerExperience", "");
  nbaUrl.searchParams.set("PlayerPosition", "");
  nbaUrl.searchParams.set("StarterBench", "");
  nbaUrl.searchParams.set("TwoWay", "");
  nbaUrl.searchParams.set("VsConference", "");
  nbaUrl.searchParams.set("VsDivision", "");

  console.log("[/nba/teamstats]", {
    season,
    seasonType,
    measureType,
    perMode,
    locationFinal,
    rawDateFrom,
    rawDateTo,
    dateFromFinal,
    dateToFinal,
    url: nbaUrl.toString(),
  });

  try {
    const out = await fetchNbaJson(nbaUrl.toString(), { timeoutMs: 45000, retryOnce: true });
    setCors(res);
    if (out.ok) return res.status(out.status).json(out.json);
    return res.status(out.status ?? 502).json(out);
  } catch (err) {
    setCors(res);
    return res.status(500).json({
      error: "NBA request failed",
      details: err?.message ?? String(err),
      code: err?.code ?? null,
    });
  }
});

/**
 * ✅ UPDATED: /nba/teamdashboard
 *
 * Calls: https://stats.nba.com/stats/teamdashboardbygeneralsplits
 *
 * ✅ CHANGES:
 * - Uses longer timeout (90s) + retry once
 *
 * Required:
 * - teamId (NBA TEAM_ID)
 *
 * Optional:
 * - season (default 2025-26)
 * - seasonType (default Regular Season)
 * - perMode (default Totals)
 * - measureType (default Base)
 * - plusMinus (default N)
 *
 * ✅ passthrough for splits:
 * - Location: Home | Road
 * - SeasonSegment: Pre All-Star | Post All-Star
 * - DateFrom/DateTo: ISO or MM/DD/YYYY
 */
app.get("/nba/teamdashboard", async (req, res) => {
  const season = req.query.season ?? "2025-26";
  const seasonType = req.query.seasonType ?? "Regular Season";
  const perMode = req.query.perMode ?? "Totals";

  // ✅ measureType + plusMinus
  const measureTypeRaw = String(req.query.measureType ?? "Base").trim();
  const allowedMeasureTypes = new Set(["Base", "Advanced", "Four Factors", "Misc"]);
  const measureType = allowedMeasureTypes.has(measureTypeRaw) ? measureTypeRaw : "Base";

  const plusMinusRaw = String(req.query.plusMinus ?? "N").trim().toUpperCase();
  const plusMinus = plusMinusRaw === "Y" ? "Y" : "N";

  // ✅ teamId required
  const teamIdRaw = String(req.query.teamId ?? req.query.TeamID ?? "").trim();
  const teamIdNum = Number(teamIdRaw);

  if (!Number.isFinite(teamIdNum) || teamIdNum <= 0) {
    setCors(res);
    return res.status(400).json({
      ok: false,
      error: "Missing or invalid teamId (NBA TEAM_ID). Example: /nba/teamdashboard?teamId=1610612737",
    });
  }

  // ✅ Location passthrough (NBA expects Home/Road)
  const rawLocation = String(req.query.Location ?? req.query.location ?? "").trim();
  const locationNorm = rawLocation
    ? rawLocation.charAt(0).toUpperCase() + rawLocation.slice(1).toLowerCase()
    : "";
  const allowedLocations = new Set(["", "Home", "Road", "Neutral"]);
  const locationFinal = allowedLocations.has(locationNorm) ? locationNorm : "";

  // ✅ SeasonSegment passthrough (NBA expects exact strings)
  const rawSeasonSegment = String(req.query.SeasonSegment ?? req.query.seasonSegment ?? "").trim();
  const allowedSeasonSegments = new Set(["", "Pre All-Star", "Post All-Star"]);
  const seasonSegmentFinal = allowedSeasonSegments.has(rawSeasonSegment) ? rawSeasonSegment : "";

  // ✅ Optional: DateFrom/DateTo passthrough (reuse existing helpers)
  const rawDateFrom = pickQuery(req, "DateFrom", "dateFrom");
  const rawDateTo = pickQuery(req, "DateTo", "dateTo");
  const dateFromFinal = isoToNbaDate(rawDateFrom);
  const dateToFinal = isoToNbaDate(rawDateTo);

  const nbaUrl = new URL("https://stats.nba.com/stats/teamdashboardbygeneralsplits");

  nbaUrl.searchParams.set("Season", season);
  nbaUrl.searchParams.set("SeasonType", seasonType);
  nbaUrl.searchParams.set("LeagueID", "00");
  nbaUrl.searchParams.set("PerMode", perMode);

  nbaUrl.searchParams.set("TeamID", String(teamIdNum));

  nbaUrl.searchParams.set("MeasureType", measureType);
  nbaUrl.searchParams.set("PlusMinus", plusMinus);

  nbaUrl.searchParams.set("PaceAdjust", "N");
  nbaUrl.searchParams.set("Rank", "N");

  nbaUrl.searchParams.set("PORound", "0");
  nbaUrl.searchParams.set("Outcome", "");
  nbaUrl.searchParams.set("Month", "0");

  // ✅ passthrough splits
  nbaUrl.searchParams.set("Location", locationFinal);
  nbaUrl.searchParams.set("SeasonSegment", seasonSegmentFinal);

  // ✅ Optional passthrough dates
  nbaUrl.searchParams.set("DateFrom", dateFromFinal);
  nbaUrl.searchParams.set("DateTo", dateToFinal);

  // leave others default/empty
  nbaUrl.searchParams.set("OpponentTeamID", "0");
  nbaUrl.searchParams.set("VsConference", "");
  nbaUrl.searchParams.set("VsDivision", "");
  nbaUrl.searchParams.set("GameSegment", "");
  nbaUrl.searchParams.set("Period", "0");
  nbaUrl.searchParams.set("LastNGames", "0");

  console.log("[/nba/teamdashboard]", {
    season,
    seasonType,
    perMode,
    teamId: teamIdNum,
    measureType,
    plusMinus,
    locationFinal,
    seasonSegmentFinal,
    rawDateFrom,
    rawDateTo,
    dateFromFinal,
    dateToFinal,
    url: nbaUrl.toString(),
  });

  try {
    // ✅ longer timeout + retry once for this heavy endpoint
    const out = await fetchNbaJson(nbaUrl.toString(), { timeoutMs: 90000, retryOnce: true });
    setCors(res);
    if (out.ok) return res.status(out.status).json(out.json);
    return res.status(out.status ?? 502).json(out);
  } catch (err) {
    setCors(res);
    return res.status(500).json({
      error: "NBA request failed",
      details: err?.message ?? String(err),
      code: err?.code ?? null,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
