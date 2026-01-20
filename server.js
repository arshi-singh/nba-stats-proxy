import express from "express";

const app = express();

// --- Basic health check (use this to verify Railway is up)
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "nba-stats-proxy" });
});

// --- NBA.com proxy: team stats (FGA, FG3A, etc.)
app.get("/nba/teamstats", async (req, res) => {
  const season = req.query.season ?? "2025-26";
  const seasonType = req.query.seasonType ?? "Regular Season";

  const nbaUrl = new URL("https://stats.nba.com/stats/leaguedashteamstats");
  nbaUrl.searchParams.set("Season", season);
  nbaUrl.searchParams.set("SeasonType", seasonType);
  nbaUrl.searchParams.set("PerMode", "Totals");
  nbaUrl.searchParams.set("MeasureType", "Base");
  nbaUrl.searchParams.set("LeagueID", "00");

  try {
    const nbaResp = await fetch(nbaUrl.toString(), {
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://www.nba.com",
        "Referer": "https://www.nba.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "x-nba-stats-origin": "stats",
        "x-nba-stats-token": "true"
      }
    });

    const text = await nbaResp.text();

    // CORS for Supabase / browser testing
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    res.status(nbaResp.status).type("application/json").send(text);
  } catch (err) {
    res.status(500).json({
      error: "NBA request failed",
      details: String(err)
    });
  }
});

// --- CORS preflight (optional, but safe)
app.options("*", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.status(204).send();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
