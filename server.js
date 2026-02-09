/**
 * Main endpoint: NBA team stats (includes FGA, FG3A, FG3_PCT, etc.)
 * Query params:
 *  - season: "2024-25" (default)
 *  - seasonType: "Regular Season" (default)
 *  - measureType: "Base" | "Advanced" (default "Base")
 *  - perMode: "Totals" | "PerGame" (default "Totals")
 *  - Location: "Home" | "Road" | "" (optional)
 *    (Also accepts lowercase location=...)
 */
app.get("/nba/teamstats", async (req, res) => {
  const season = req.query.season ?? "2025-26";
  const seasonType = req.query.seasonType ?? "Regular Season";

  const measureType = req.query.measureType ?? "Base";
  const perMode = req.query.perMode ?? "Totals";

  // ✅ PASS-THROUGH LOCATION (fix)
  // Accept Location or location; normalize; allow Home/Road; blank means overall
  const rawLocation = (req.query.Location ?? req.query.location ?? "").toString().trim();
  const locationNorm = rawLocation
    ? rawLocation.charAt(0).toUpperCase() + rawLocation.slice(1).toLowerCase()
    : ""; // "" => overall

  // Only allow known values to avoid weird upstream behavior
  const allowedLocations = new Set(["", "Home", "Road", "Neutral"]);
  const locationFinal = allowedLocations.has(locationNorm) ? locationNorm : "";

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

  // ✅ HERE: do NOT force Location to ""
  // If caller didn't pass Location, we keep it blank (overall).
  nbaUrl.searchParams.set("Location", locationFinal);

  nbaUrl.searchParams.set("Outcome", "");
  nbaUrl.searchParams.set("SeasonSegment", "");
  nbaUrl.searchParams.set("DateFrom", "");
  nbaUrl.searchParams.set("DateTo", "");
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
    url: nbaUrl.toString(),
  });

  try {
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
        ...(cookieHeader ? { Cookie: cookieHeader } : {})
      },
      validateStatus: () => true
    });

    setCors(res);

    const ct = (nbaResp.headers["content-type"] ?? "").toLowerCase();
    const rawText = Buffer.from(nbaResp.data || []).toString("utf8");
    const snippet = rawText.slice(0, 500);

    if (ct.includes("application/json") || snippet.trim().startsWith("{")) {
      try {
        const json = JSON.parse(rawText);
        return res.status(nbaResp.status).json(json);
      } catch {
        // fall through
      }
    }

    return res.status(502).json({
      ok: false,
      error: "Upstream did not return JSON",
      upstreamStatus: nbaResp.status,
      contentType: nbaResp.headers["content-type"] ?? null,
      headerKeys: Object.keys(nbaResp.headers || {}),
      primeStatus: prime.status,
      primeSetCookieCount: Array.isArray(setCookies) ? setCookies.length : 0,
      // ✅ include location we tried
      locationFinal,
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
