/**
 * Sports Resolver (Time-Aware)
 * Fetches live scores, standings, and game data from ESPN's public API
 * to resolve prediction markets about sports outcomes
 *
 * Supported: NFL, NBA, MLB, NHL, MMA/UFC, Soccer, Tennis, Golf, College Basketball
 *
 * ESPN public API (no auth required):
 *   Scoreboard: site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard
 *   Standings:  site.api.espn.com/apis/site/v2/sports/{sport}/{league}/standings
 *
 * Confidence model:
 *   - Game FINISHED: 95% confidence
 *   - Game IN PROGRESS: score + time → 70-95% (blowouts = higher)
 *   - Pre-game: standings/record → 60-70%
 */

import https from 'https';
import { DFlowMarket, ResolverResult } from '../dflow/types';
import logger from '../logger';

// ─── ESPN Configuration ────────────────────────────────────────────

const ESPN_BASE = 'site.api.espn.com';

interface LeagueConfig {
  sport: string;
  league: string;
  keywords: string[];
}

const LEAGUE_MAP: Record<string, LeagueConfig> = {
  NFL:  { sport: 'football',   league: 'nfl',               keywords: ['nfl', 'football', 'super bowl', 'touchdown', 'quarterback'] },
  NBA:  { sport: 'basketball', league: 'nba',               keywords: ['nba', 'basketball'] },
  NCAAB:{ sport: 'basketball', league: 'mens-college-basketball', keywords: ['ncaa', 'college basketball', 'march madness', 'ncaab'] },
  MLB:  { sport: 'baseball',   league: 'mlb',               keywords: ['mlb', 'baseball'] },
  NHL:  { sport: 'hockey',     league: 'nhl',               keywords: ['nhl', 'hockey', 'stanley cup'] },
  UFC:  { sport: 'mma',        league: 'ufc',               keywords: ['ufc', 'mma', 'fight', 'fighter'] },
  EPL:  { sport: 'soccer',     league: 'eng.1',             keywords: ['premier league', 'epl'] },
  MLS:  { sport: 'soccer',     league: 'usa.1',             keywords: ['mls', 'major league soccer'] },
  LIGA: { sport: 'soccer',     league: 'esp.1',             keywords: ['la liga'] },
  CL:   { sport: 'soccer',     league: 'uefa.champions',    keywords: ['champions league', 'ucl'] },
  ATP:  { sport: 'tennis',     league: 'atp',               keywords: ['atp', 'tennis'] },
  WTA:  { sport: 'tennis',     league: 'wta',               keywords: ['wta'] },
  PGA:  { sport: 'golf',       league: 'pga',               keywords: ['pga', 'golf', 'masters', 'open championship'] },
};

// Common team name aliases
const TEAM_ALIASES: Record<string, string[]> = {
  // NFL
  'chiefs':      ['kansas city chiefs', 'kc chiefs', 'chiefs'],
  'eagles':      ['philadelphia eagles', 'philly eagles', 'eagles'],
  'bills':       ['buffalo bills', 'bills'],
  '49ers':       ['san francisco 49ers', 'sf 49ers', '49ers', 'niners'],
  'cowboys':     ['dallas cowboys', 'cowboys'],
  'ravens':      ['baltimore ravens', 'ravens'],
  'lions':       ['detroit lions', 'lions'],
  'packers':     ['green bay packers', 'packers'],
  // NBA
  'celtics':     ['boston celtics', 'celtics'],
  'lakers':      ['los angeles lakers', 'la lakers', 'lakers'],
  'nuggets':     ['denver nuggets', 'nuggets'],
  'warriors':    ['golden state warriors', 'warriors', 'gsw'],
  'bucks':       ['milwaukee bucks', 'bucks'],
  'heat':        ['miami heat', 'heat'],
  'thunder':     ['oklahoma city thunder', 'okc thunder', 'okc', 'thunder'],
  'cavaliers':   ['cleveland cavaliers', 'cavs', 'cavaliers'],
  // MLB
  'yankees':     ['new york yankees', 'ny yankees', 'yankees'],
  'dodgers':     ['los angeles dodgers', 'la dodgers', 'dodgers'],
  'astros':      ['houston astros', 'astros'],
  'braves':      ['atlanta braves', 'braves'],
  // NHL
  'oilers':      ['edmonton oilers', 'oilers'],
  'panthers':    ['florida panthers', 'panthers'],
  'avalanche':   ['colorado avalanche', 'avalanche', 'avs'],
  'rangers':     ['new york rangers', 'ny rangers', 'rangers'],
};

// ─── ESPN API Types ────────────────────────────────────────────────

interface ESPNCompetitor {
  id: string;
  team: {
    displayName: string;
    shortDisplayName: string;
    abbreviation: string;
  };
  score?: string;
  winner?: boolean;
  records?: Array<{ summary: string; type: string }>;
  curatedRank?: { current: number };
}

interface ESPNCompetition {
  id: string;
  date: string;
  status: {
    type: {
      id: string;
      name: string;           // 'STATUS_FINAL', 'STATUS_IN_PROGRESS', 'STATUS_SCHEDULED'
      completed: boolean;
    };
    displayClock?: string;    // "4:32", "0:00"
    period?: number;          // Quarter/period number
  };
  competitors: ESPNCompetitor[];
  odds?: Array<{
    details: string;         // "KC -3.5"
    overUnder: number;
    spread: number;
    homeTeamOdds?: { moneyLine: number };
    awayTeamOdds?: { moneyLine: number };
  }>;
}

interface ESPNEvent {
  id: string;
  name: string;               // "Team A at Team B"
  shortName: string;          // "TA @ TB"
  date: string;
  competitions: ESPNCompetition[];
}

interface ESPNScoreboardResponse {
  events: ESPNEvent[];
}

interface ESPNStandingsEntry {
  team: {
    displayName: string;
    abbreviation: string;
  };
  stats: Array<{
    name: string;
    value: number;
    displayValue: string;
  }>;
}

interface ESPNStandingsGroup {
  name: string;
  standings: {
    entries: ESPNStandingsEntry[];
  };
}

// ─── ESPN API Fetchers ─────────────────────────────────────────────

const apiCache: Map<string, { data: unknown; timestamp: number }> = new Map();
const API_CACHE_TTL_MS = 30_000; // 30 seconds

async function fetchESPN<T>(path: string): Promise<T | null> {
  const cached = apiCache.get(path);
  if (cached && Date.now() - cached.timestamp < API_CACHE_TTL_MS) {
    return cached.data as T;
  }

  return new Promise((resolve) => {
    https.get({
      hostname: ESPN_BASE,
      path,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Parallax/1.0',
      },
      timeout: 10_000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data) as T;
          apiCache.set(path, { data: json, timestamp: Date.now() });
          resolve(json);
        } catch {
          logger.debug({ path, response: data.substring(0, 200) }, 'Failed to parse ESPN response');
          resolve(null);
        }
      });
    }).on('error', (e) => {
      logger.debug({ path, error: (e as Error).message }, 'ESPN request failed');
      resolve(null);
    });
  });
}

async function fetchScoreboard(sport: string, league: string, date?: string): Promise<ESPNScoreboardResponse | null> {
  let path = `/apis/site/v2/sports/${sport}/${league}/scoreboard`;
  if (date) {
    path += `?dates=${date}`; // Format: YYYYMMDD
  }
  return fetchESPN<ESPNScoreboardResponse>(path);
}

async function fetchStandings(sport: string, league: string): Promise<{ children: ESPNStandingsGroup[] } | null> {
  const path = `/apis/site/v2/sports/${sport}/${league}/standings`;
  return fetchESPN<{ children: ESPNStandingsGroup[] }>(path);
}

// ─── Market Analysis Helpers ───────────────────────────────────────

/**
 * Detect which league(s) a market is about
 */
function detectLeague(title: string, ticker: string): LeagueConfig | null {
  const combined = (title + ' ' + ticker).toLowerCase();

  // Check specific leagues first (more specific matches before generic)
  for (const [, config] of Object.entries(LEAGUE_MAP)) {
    for (const keyword of config.keywords) {
      if (combined.includes(keyword)) {
        return config;
      }
    }
  }

  // Generic soccer match
  if (combined.includes('soccer') || combined.includes('football') && !combined.includes('nfl')) {
    // Only if it seems like soccer (non-American)
    if (combined.includes('goal') || combined.includes('nil') || combined.includes('fc ')) {
      return LEAGUE_MAP.EPL; // Default to EPL
    }
  }

  return null;
}

/**
 * Extract team name from market title
 * "Will the Chiefs win the Super Bowl?" → "Chiefs"
 * "Will the Lakers beat the Celtics?" → { team: "Lakers", opponent: "Celtics" }
 */
function extractTeams(title: string): { team: string; opponent?: string } | null {
  const lower = title.toLowerCase();

  // Pattern: "Will [Team] win..." or "Will [Team] beat..."
  const winMatch = lower.match(/will (?:the )?(.+?)(?:\s+win|\s+beat|\s+defeat|\s+make)/i);
  if (winMatch) {
    const teamStr = winMatch[1].trim();

    // Check for "beat/defeat [Opponent]"
    const opponentMatch = lower.match(/(?:beat|defeat)\s+(?:the\s+)?(.+?)(?:\?|$)/i);
    const opponent = opponentMatch ? opponentMatch[1].trim().replace(/\?$/, '') : undefined;

    return { team: teamStr, opponent };
  }

  // Pattern: "[Team] vs [Team]" or "[Team] at [Team]"
  const vsMatch = lower.match(/(.+?)\s+(?:vs\.?|at|@)\s+(.+?)(?:\?|$)/i);
  if (vsMatch) {
    return {
      team: vsMatch[1].replace(/^will\s+/i, '').trim(),
      opponent: vsMatch[2].trim().replace(/\?$/, ''),
    };
  }

  return null;
}

/**
 * Normalize a team name for fuzzy matching
 */
function normalizeTeamName(name: string): string {
  return name.toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

/**
 * Check if two team names match (fuzzy)
 */
function teamsMatch(nameA: string, nameB: string): boolean {
  const a = normalizeTeamName(nameA);
  const b = normalizeTeamName(nameB);

  // Direct match
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  // Check aliases
  for (const aliases of Object.values(TEAM_ALIASES)) {
    const normAliases = aliases.map(normalizeTeamName);
    const aInAliases = normAliases.some(al => al.includes(a) || a.includes(al));
    const bInAliases = normAliases.some(al => al.includes(b) || b.includes(al));
    if (aInAliases && bInAliases) return true;
  }

  // Abbreviation match — check if abbreviation is in the other name
  if (a.length <= 4 || b.length <= 4) {
    // Short string might be abbreviation
    return false; // Don't false-positive on short strings
  }

  return false;
}

/**
 * Find a game on the scoreboard matching the teams
 */
function findGame(
  events: ESPNEvent[],
  teamName: string,
  opponentName?: string,
): ESPNCompetition | null {
  for (const event of events) {
    for (const comp of event.competitions) {
      const competitors = comp.competitors;
      if (competitors.length < 2) continue;

      const matchesTeam = competitors.some(
        c => teamsMatch(c.team.displayName, teamName) ||
             teamsMatch(c.team.shortDisplayName, teamName) ||
             teamsMatch(c.team.abbreviation, teamName)
      );

      if (matchesTeam) {
        // If opponent specified, check that too
        if (opponentName) {
          const matchesOpponent = competitors.some(
            c => teamsMatch(c.team.displayName, opponentName) ||
                 teamsMatch(c.team.shortDisplayName, opponentName) ||
                 teamsMatch(c.team.abbreviation, opponentName)
          );
          if (!matchesOpponent) continue;
        }
        return comp;
      }
    }
  }
  return null;
}

/**
 * Determine the game status category
 */
type GamePhase = 'finished' | 'in_progress' | 'scheduled' | 'unknown';

function getGamePhase(status: ESPNCompetition['status']): GamePhase {
  const name = status.type.name.toUpperCase();
  if (status.type.completed || name.includes('FINAL')) return 'finished';
  if (name.includes('IN_PROGRESS') || name.includes('HALFTIME') || name.includes('END_PERIOD')) return 'in_progress';
  if (name.includes('SCHEDULED') || name.includes('PRE')) return 'scheduled';
  return 'unknown';
}

/**
 * Calculate confidence for an in-progress game
 * Based on score difference relative to time remaining
 */
function getInProgressConfidence(
  competition: ESPNCompetition,
  teamIndex: number,
  leagueConfig: LeagueConfig,
): number {
  const competitors = competition.competitors;
  const teamScore = parseInt(competitors[teamIndex].score || '0', 10);
  const oppIndex = teamIndex === 0 ? 1 : 0;
  const oppScore = parseInt(competitors[oppIndex].score || '0', 10);
  const scoreDiff = teamScore - oppScore;
  const period = competition.status.period || 1;
  const clock = competition.status.displayClock || '';

  // Parse remaining time (rough)
  let gameProgressPct = 0.5; // Default: middle of game

  switch (leagueConfig.league) {
    case 'nfl': {
      // NFL: 4 quarters, 15 min each
      const totalPeriods = 4;
      const periodMinutes = 15;
      const clockMin = parseClockMinutes(clock);
      gameProgressPct = ((period - 1) * periodMinutes + (periodMinutes - clockMin)) / (totalPeriods * periodMinutes);
      break;
    }
    case 'nba':
    case 'mens-college-basketball': {
      // NBA: 4 quarters, 12 min each / NCAAB: 2 halves, 20 min each
      const totalPeriods = leagueConfig.league === 'nba' ? 4 : 2;
      const periodMinutes = leagueConfig.league === 'nba' ? 12 : 20;
      const clockMin = parseClockMinutes(clock);
      gameProgressPct = ((period - 1) * periodMinutes + (periodMinutes - clockMin)) / (totalPeriods * periodMinutes);
      break;
    }
    case 'nhl': {
      // NHL: 3 periods, 20 min each
      const clockMin = parseClockMinutes(clock);
      gameProgressPct = ((period - 1) * 20 + (20 - clockMin)) / 60;
      break;
    }
    case 'mlb': {
      // MLB: 9 innings
      gameProgressPct = Math.min(period / 9, 1.0);
      break;
    }
    default: {
      // Soccer: 2 halves, 45 min each
      const clockMin = parseClockMinutes(clock);
      gameProgressPct = Math.min(((period - 1) * 45 + clockMin) / 90, 1.0);
      break;
    }
  }

  gameProgressPct = Math.max(0, Math.min(1, gameProgressPct));

  // Confidence based on score difference * game progress
  // Large lead late in game = very high confidence
  // Small lead early = low confidence
  const absScoreDiff = Math.abs(scoreDiff);

  // Normalize score difference by sport
  let normalizedDiff: number;
  switch (leagueConfig.league) {
    case 'nfl':
      normalizedDiff = absScoreDiff / 14; // 2 TDs = normalized 1.0
      break;
    case 'nba':
    case 'mens-college-basketball':
      normalizedDiff = absScoreDiff / 15; // 15 pts = normalized 1.0
      break;
    case 'nhl':
      normalizedDiff = absScoreDiff / 3;  // 3 goals = normalized 1.0
      break;
    case 'mlb':
      normalizedDiff = absScoreDiff / 5;  // 5 runs = normalized 1.0
      break;
    default: // soccer
      normalizedDiff = absScoreDiff / 2;  // 2 goals = normalized 1.0
      break;
  }

  // Combine progress and lead
  // Late game + big lead = high confidence
  const raw = 0.55 + gameProgressPct * 0.25 + Math.min(normalizedDiff, 1.5) * 0.15;
  return Math.min(0.95, Math.max(0.55, raw));
}

/**
 * Parse clock string like "4:32" into minutes
 */
function parseClockMinutes(clock: string): number {
  if (!clock) return 0;
  const parts = clock.split(':');
  if (parts.length === 2) {
    return parseInt(parts[0], 10) + parseInt(parts[1], 10) / 60;
  }
  return parseFloat(clock) || 0;
}

/**
 * Calculate pre-game confidence based on team records and standings
 */
function getPreGameConfidence(
  teamRecord: string | undefined,
  opponentRecord: string | undefined,
): number {
  if (!teamRecord) return 0.55;

  const parseRecord = (rec: string): { wins: number; losses: number; pct: number } | null => {
    const match = rec.match(/(\d+)-(\d+)/);
    if (!match) return null;
    const wins = parseInt(match[1], 10);
    const losses = parseInt(match[2], 10);
    const total = wins + losses;
    return { wins, losses, pct: total > 0 ? wins / total : 0.5 };
  };

  const team = parseRecord(teamRecord);
  if (!team) return 0.55;

  const opponent = opponentRecord ? parseRecord(opponentRecord) : null;

  // Win probability based on records (simple model)
  let winProb: number;
  if (opponent) {
    // Log5 method: P(A wins) = (pA * (1-pB)) / (pA*(1-pB) + pB*(1-pA))
    const pA = Math.max(0.1, Math.min(0.9, team.pct));
    const pB = Math.max(0.1, Math.min(0.9, opponent.pct));
    winProb = (pA * (1 - pB)) / (pA * (1 - pB) + pB * (1 - pA));
  } else {
    winProb = team.pct;
  }

  // Map win probability to confidence range 0.55-0.70
  // We're not super confident pre-game since upsets happen
  const confidence = 0.55 + Math.abs(winProb - 0.5) * 0.30;
  return Math.min(0.70, Math.max(0.55, confidence));
}

/**
 * Detect if market is about playoffs/championship
 */
function isPlayoffMarket(title: string): boolean {
  const lower = title.toLowerCase();
  return (
    lower.includes('playoff') ||
    lower.includes('championship') ||
    lower.includes('super bowl') ||
    lower.includes('world series') ||
    lower.includes('stanley cup') ||
    lower.includes('nba finals') ||
    lower.includes('march madness') ||
    lower.includes('make the playoffs') ||
    lower.includes('win the title')
  );
}

/**
 * Parse a date from market title for scoreboard queries
 * "...on Feb 10, 2026?" → "20260210"
 */
function parseDateFromTitle(title: string): string | null {
  // Pattern: "Month DD, YYYY" or "MM/DD/YYYY"
  const monthNames: Record<string, string> = {
    jan: '01', january: '01',
    feb: '02', february: '02',
    mar: '03', march: '03',
    apr: '04', april: '04',
    may: '05',
    jun: '06', june: '06',
    jul: '07', july: '07',
    aug: '08', august: '08',
    sep: '09', september: '09',
    oct: '10', october: '10',
    nov: '11', november: '11',
    dec: '12', december: '12',
  };

  const dateMatch = title.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/i);
  if (dateMatch) {
    const monthNum = monthNames[dateMatch[1].toLowerCase()];
    if (monthNum) {
      const day = dateMatch[2].padStart(2, '0');
      return `${dateMatch[3]}${monthNum}${day}`;
    }
  }

  // Try "tonight", "today"
  const lower = title.toLowerCase();
  if (lower.includes('today') || lower.includes('tonight')) {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }

  return null;
}

// ─── Main Resolver ─────────────────────────────────────────────────

/**
 * Resolve a sports market using ESPN data
 * Handles: game outcomes, playoffs, championships
 */
export async function resolveSportsMarket(market: DFlowMarket): Promise<{
  outcome: 'yes' | 'no';
  confidence: number;
  data: ResolverResult;
} | null> {
  const { title, ticker } = market;

  // Detect the league
  const leagueConfig = detectLeague(title, ticker);
  if (!leagueConfig) {
    logger.debug({ ticker, title }, 'Could not detect sports league');
    return null;
  }

  // Extract team(s) from the title
  const teams = extractTeams(title);
  if (!teams) {
    logger.debug({ ticker, title }, 'Could not extract teams from sports market');
    return null;
  }

  // Determine date to query
  const dateStr = parseDateFromTitle(title);

  // Fetch scoreboard for the relevant date
  const scoreboard = await fetchScoreboard(leagueConfig.sport, leagueConfig.league, dateStr || undefined);
  if (!scoreboard || !scoreboard.events || scoreboard.events.length === 0) {
    // If no scoreboard, try standings for playoff/season markets
    if (isPlayoffMarket(title)) {
      return resolvePlayoffMarket(market, leagueConfig, teams.team);
    }
    logger.debug({ ticker, league: leagueConfig.league, date: dateStr }, 'No ESPN scoreboard data');
    return null;
  }

  // Find the game matching the team
  const game = findGame(scoreboard.events, teams.team, teams.opponent);
  if (!game) {
    // Maybe this is a playoffs/standings market
    if (isPlayoffMarket(title)) {
      return resolvePlayoffMarket(market, leagueConfig, teams.team);
    }
    logger.debug({ ticker, team: teams.team, opponent: teams.opponent }, 'Could not find matching game on scoreboard');
    return null;
  }

  // Identify which competitor is "our" team
  const teamIndex = game.competitors.findIndex(
    c => teamsMatch(c.team.displayName, teams.team) ||
         teamsMatch(c.team.shortDisplayName, teams.team) ||
         teamsMatch(c.team.abbreviation, teams.team)
  );
  if (teamIndex === -1) return null;

  const oppIndex = teamIndex === 0 ? 1 : 0;
  const phase = getGamePhase(game.status);
  const teamScore = parseInt(game.competitors[teamIndex].score || '0', 10);
  const oppScore = parseInt(game.competitors[oppIndex].score || '0', 10);

  let outcome: 'yes' | 'no';
  let confidence: number;
  let dataValue: string;

  switch (phase) {
    case 'finished': {
      // Game is over — definitive result
      outcome = teamScore > oppScore ? 'yes' : 'no';
      confidence = 0.95;
      dataValue = `Final: ${game.competitors[teamIndex].team.abbreviation} ${teamScore} - ${oppScore} ${game.competitors[oppIndex].team.abbreviation}`;
      break;
    }
    case 'in_progress': {
      // Game is live — confidence based on score + time
      outcome = teamScore >= oppScore ? 'yes' : 'no';
      confidence = getInProgressConfidence(game, teamIndex, leagueConfig);
      const clock = game.status.displayClock || '';
      const period = game.status.period || 0;
      dataValue = `Live: ${game.competitors[teamIndex].team.abbreviation} ${teamScore} - ${oppScore} ${game.competitors[oppIndex].team.abbreviation} (P${period} ${clock})`;
      break;
    }
    case 'scheduled':
    default: {
      // Game hasn't started — use records for rough estimate
      const teamRecord = game.competitors[teamIndex].records?.find(r => r.type === 'total')?.summary;
      const oppRecord = game.competitors[oppIndex].records?.find(r => r.type === 'total')?.summary;
      confidence = getPreGameConfidence(teamRecord, oppRecord);

      // Check odds if available
      if (game.odds && game.odds.length > 0) {
        const odds = game.odds[0];
        // Try to infer favorite from spread/moneyline
        const spread = odds.spread;
        if (spread !== undefined && spread !== 0) {
          // Negative spread = favorite. Home team (index 0) spread convention
          const teamIsHome = teamIndex === 0;
          const teamSpread = teamIsHome ? spread : -spread;
          // Favorite has negative spread
          outcome = teamSpread < 0 ? 'yes' : 'no';
          // Convert spread to win probability (rough)
          const absSpr = Math.abs(teamSpread);
          const spreadProb = 0.50 + Math.min(absSpr / 20, 0.25); // 10pt favorite ≈ 62.5%
          confidence = Math.min(0.70, 0.55 + (spreadProb - 0.50) * 0.60);
        } else {
          outcome = confidence >= 0.55 ? 'yes' : 'no';
        }
      } else {
        // No odds, use record-based estimate
        const teamRecord2 = game.competitors[teamIndex].records?.find(r => r.type === 'total')?.summary;
        const oppRecord2 = game.competitors[oppIndex].records?.find(r => r.type === 'total')?.summary;
        const parseWinPct = (r?: string) => {
          if (!r) return 0.5;
          const m = r.match(/(\d+)-(\d+)/);
          if (!m) return 0.5;
          const w = parseInt(m[1], 10);
          const l = parseInt(m[2], 10);
          return (w + l) > 0 ? w / (w + l) : 0.5;
        };
        outcome = parseWinPct(teamRecord2) >= parseWinPct(oppRecord2) ? 'yes' : 'no';
      }

      const teamRec = game.competitors[teamIndex].records?.find(r => r.type === 'total')?.summary || '?';
      const oppRec = game.competitors[oppIndex].records?.find(r => r.type === 'total')?.summary || '?';
      dataValue = `Scheduled: ${game.competitors[teamIndex].team.abbreviation} (${teamRec}) vs ${game.competitors[oppIndex].team.abbreviation} (${oppRec})`;
      break;
    }
  }

  logger.info({
    ticker: market.ticker,
    team: teams.team,
    phase,
    outcome,
    confidence: confidence.toFixed(3),
    score: `${teamScore}-${oppScore}`,
  }, 'Sports market resolved');

  return {
    outcome,
    confidence,
    data: {
      category: 'sports',
      dataValue,
      numericValue: teamScore - oppScore, // Score differential
      confidence,
      source: 'ESPN',
      sourceUrl: `https://www.espn.com/${leagueConfig.sport}/${leagueConfig.league === 'nfl' ? '' : leagueConfig.league + '/'}scoreboard`,
      timestamp: Date.now(),
    },
  };
}

/**
 * Resolve playoff/championship market using standings
 */
async function resolvePlayoffMarket(
  market: DFlowMarket,
  leagueConfig: LeagueConfig,
  teamName: string,
): Promise<{ outcome: 'yes' | 'no'; confidence: number; data: ResolverResult } | null> {
  const standings = await fetchStandings(leagueConfig.sport, leagueConfig.league);
  if (!standings || !standings.children) {
    logger.debug({ league: leagueConfig.league }, 'No standings data from ESPN');
    return null;
  }

  // Search through all divisions/conferences for the team
  let teamEntry: ESPNStandingsEntry | null = null;
  let divisionName = '';

  for (const group of standings.children) {
    // Some leagues have nested children (conferences > divisions)
    const entries = group.standings?.entries;
    if (entries) {
      for (const entry of entries) {
        if (
          teamsMatch(entry.team.displayName, teamName) ||
          teamsMatch(entry.team.abbreviation, teamName)
        ) {
          teamEntry = entry;
          divisionName = group.name;
          break;
        }
      }
    }
    if (teamEntry) break;
  }

  if (!teamEntry) {
    logger.debug({ team: teamName, league: leagueConfig.league }, 'Team not found in standings');
    return null;
  }

  // Extract record stats
  const winsStr = teamEntry.stats.find(s => s.name === 'wins')?.displayValue;
  const lossesStr = teamEntry.stats.find(s => s.name === 'losses')?.displayValue;
  const wins = winsStr ? parseInt(winsStr, 10) : 0;
  const losses = lossesStr ? parseInt(lossesStr, 10) : 0;
  const total = wins + losses;
  const winPct = total > 0 ? wins / total : 0.5;

  // Simple playoff probability based on record
  // Top ~50% make playoffs in most leagues
  // Win% > 0.600 → likely playoff team
  // Win% > 0.500 → borderline
  // Win% < 0.400 → unlikely
  let playoffProb: number;
  if (winPct >= 0.700) {
    playoffProb = 0.90;
  } else if (winPct >= 0.600) {
    playoffProb = 0.75;
  } else if (winPct >= 0.500) {
    playoffProb = 0.50;
  } else if (winPct >= 0.400) {
    playoffProb = 0.25;
  } else {
    playoffProb = 0.10;
  }

  // Confidence is moderate for season-long predictions (lots of games left)
  const hoursToExpiry = (market.expirationTime * 1000 - Date.now()) / (1000 * 60 * 60);
  let confidence: number;
  if (hoursToExpiry < 24) {
    // Season ending soon — standings are nearly final
    confidence = Math.min(0.90, 0.70 + winPct * 0.20);
  } else if (hoursToExpiry < 24 * 30) {
    // Within a month
    confidence = Math.min(0.75, 0.55 + winPct * 0.15);
  } else {
    // Far out — low confidence
    confidence = Math.min(0.65, 0.50 + winPct * 0.10);
  }

  const outcome: 'yes' | 'no' = playoffProb >= 0.50 ? 'yes' : 'no';
  const record = `${wins}-${losses}`;

  logger.info({
    ticker: market.ticker,
    team: teamName,
    record,
    winPct: winPct.toFixed(3),
    playoffProb: playoffProb.toFixed(3),
    confidence: confidence.toFixed(3),
    outcome,
  }, 'Playoff market resolved via standings');

  return {
    outcome,
    confidence,
    data: {
      category: 'sports',
      dataValue: `${teamEntry.team.displayName} (${record}, ${divisionName})`,
      numericValue: winPct,
      confidence,
      source: 'ESPN',
      sourceUrl: `https://www.espn.com/${leagueConfig.sport}/${leagueConfig.league}/standings`,
      timestamp: Date.now(),
    },
  };
}

// Export helpers for testing
export { detectLeague, extractTeams, teamsMatch, findGame, getGamePhase, LEAGUE_MAP };
