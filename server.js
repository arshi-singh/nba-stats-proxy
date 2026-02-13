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
 * - measureType (default Base)  ✅ NEW
 * - plusMinus (default N)       ✅ NEW
 */
app.get("/nba/teamdashboard", async (req, res) => {
  const season = req.query.season ?? "2025-26";
  const seasonType = req.query.seasonType ?? "Regular Season";
  const perMode = req.query.perMode ?? "Totals";

  // ✅ NEW: passthrough measureType + plusMinus
  const measureTypeRaw = String(req.query.measureType ?? "Base").trim();
  const allowedMeasureTypes = new Set(["Base", "Advanced", "Four Factors", "Misc"]);
  const measureType = allowedMeasureTypes.has(measureTypeRaw) ? measureTypeRaw : "Base";

  const plusMinusRaw = String(req.query.plusMinus ?? "N").trim().toUpperCase();
  const plusMinus = plusMinusRaw === "Y" ? "Y" : "N";

  const teamIdRaw = String(req.query.teamId ?? req.query.TeamID ?? "").trim();
  const teamIdNum = Number(teamIdRaw);

  if (!Number.isFinite(teamIdNum) || teamIdNum <= 0) {
    setCors(res);
    return res.status(400).json({
      ok: false,
      error: "Missing or invalid teamId (NBA TEAM_ID). Example: /nba/teamdashboard?teamId=1610612737",
    });
  }

  const nbaUrl = new URL("https://stats.nba.com/stats/teamdashboardbygeneralsplits");

  nbaUrl.searchParams.set("Season", season);
  nbaUrl.searchParams.set("SeasonType", seasonType);
  nbaUrl.searchParams.set("LeagueID", "00");
  nbaUrl.searchParams.set("PerMode", perMode);

  nbaUrl.searchParams.set("TeamID", String(teamIdNum));

  // ✅ NOW passthrough
  nbaUrl.searchParams.set("MeasureType", measureType);
  nbaUrl.searchParams.set("PlusMinus", plusMinus);

  nbaUrl.searchParams.set("PaceAdjust", "N");
  nbaUrl.searchParams.set("Rank", "N");

  nbaUrl.searchParams.set("PORound", "0");
  nbaUrl.searchParams.set("Outcome", "");
  nbaUrl.searchParams.set("Location", "");
  nbaUrl.searchParams.set("Month", "0");
  nbaUrl.searchParams.set("SeasonSegment", "");
  nbaUrl.searchParams.set("DateFrom", "");
  nbaUrl.searchParams.set("DateTo", "");
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
