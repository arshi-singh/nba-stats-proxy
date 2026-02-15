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
 */
async function primeCookies() {
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

  return { primeStatus: prime.status, cookieHeader };
}

async function fetchNbaJson(url) {
  const { primeStatus, cookieHeader } = await primeCookies();

  const nbaResp = await axios.get(url, {
    httpsAgent,
    timeout: 45000,
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

  // Try parse JSON (even if ct is weird)
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
    const out = await fetchNbaJson(nbaUrl.toString());
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
 * ✅ NEW passthrough for splits:
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

  // ✅ NEW: Location passthrough (NBA expects Home/Road)
  const rawLocation = String(req.query.Location ?? req.query.location ?? "").trim();
  const locationNorm = rawLocation
    ? rawLocation.charAt(0).toUpperCase() + rawLocation.slice(1).toLowerCase()
    : "";
  const allowedLocations = new Set(["", "Home", "Road", "Neutral"]);
  const locationFinal = allowedLocations.has(locationNorm) ? locationNorm : "";

  // ✅ NEW: SeasonSegment passthrough (NBA expects exact strings)
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

  // ✅ NOW passthrough splits
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
    const out = await fetchNbaJson(nbaUrl.toString());
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
