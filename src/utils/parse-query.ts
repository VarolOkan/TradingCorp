// src/utils/parse-query.ts
// Extracted from the old OrchestratorNode so the orchestrator logic can live
// as a pure handler (registry/logic/orchestrator.ts) and be unit-tested
// without a node class. Pure function: query string -> { tickers, options }.
//
// Parsing model (single source of truth):
//   - depth / time_horizon / risk_tolerance are detected by KEYWORD matching on
//     the whole query (e.g. "quick", "deep dive", "short term", "conservative").
//   - tickers are detected by scanning 1-5 uppercase-letter tokens and dropping
//     a denylist of common words + the option-keyword tokens above.
// No whole-query equality branches — so free-form phrasing parses correctly
// instead of falling through to the denylisted regex path.

export interface ParsedQuery {
  tickers: string[];
  options: {
    depth: 'QUICK' | 'STANDARD' | 'DEEP';
    time_horizon: 'SHORT_TERM' | 'MEDIUM_TERM' | 'LONG_TERM';
    risk_tolerance: 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE';
  };
}

export function parseQuery(query: string): ParsedQuery {
  const options: ParsedQuery['options'] = {
    depth: 'STANDARD',
    time_horizon: 'MEDIUM_TERM',
    risk_tolerance: 'MODERATE',
  };

  const q = query.toUpperCase();

  // --- option detection via keyword matching (the single source of truth) ---
  if (/QUICK|FAST|BRIEF/.test(q)) options.depth = 'QUICK';
  else if (/DEEP|DIVE|IN-?DEPTH|DETAILED/.test(q)) options.depth = 'DEEP';

  if (/SHORT\s*TERM|INTRADAY|SWING/.test(q)) options.time_horizon = 'SHORT_TERM';
  else if (/LONG\s*TERM/.test(q)) options.time_horizon = 'LONG_TERM';

  if (/CONSERVATIVE|DEFENSIVE|SAFE/.test(q)) options.risk_tolerance = 'CONSERVATIVE';
  else if (/AGGRESSIVE|BULLISH/.test(q)) options.risk_tolerance = 'AGGRESSIVE';

  // Token denylist: common English words + the option-keyword tokens above, so
  // they are never mistaken for tickers. (Tickers are indistinguishable from
  // words without a dictionary, so this is the pragmatic filter.)
  const obviousNonTickers = new Set([
    'THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT', 'YOU', 'ALL', 'ANY', 'CAN', 'HER', 'WAS', 'ONE', 'OUR', 'OUT',
    'DAY', 'GET', 'HAS', 'HIM', 'HIS', 'HOW', 'ITS', 'LET', 'NEW', 'NOW', 'OLD', 'SEE', 'TWO', 'WHO', 'BOY',
    'DID', 'GOT', 'MAN', 'PUT', 'SET', 'TOO', 'USE', 'WHY', 'YES', 'YET', 'ANALYZE', 'ANALYSIS', 'WHAT',
    'ABOUT', 'IS', 'STOCK', 'STOCKS', 'SHARE', 'SHARES', 'EQUITY', 'INVEST', 'INVESTMENT',
    'TO', 'IN', 'ON', 'AT', 'BY', 'WITH', 'BUY', 'SELL', 'HOLD', 'LONG', 'SHORT', 'CALL',
    'MARKET', 'PRICE', 'VOLUME', 'TREND', 'UP', 'DOWN', 'HIGH', 'LOW', 'OPEN', 'CLOSE', 'THEN',
    'HERE', 'THERE', 'WHEN', 'WHERE', 'EACH', 'FEW', 'MORE', 'MOST',
    'OTHER', 'SOME', 'SUCH', 'ONLY', 'OWN', 'SAME', 'SO', 'THAN', 'VERY', 'WILL', 'DONT',
    'ISNT', 'WASNT', 'WERENT', 'HAVENT', 'HASNT', 'HADNT', 'CHECK', 'TODAY',
    // option-keyword tokens (must not be treated as tickers)
    'QUICK', 'FAST', 'BRIEF', 'DEEP', 'DIVE', 'DETAILED', 'TERM', 'TRADING',
    'INTRADAY', 'SWING', 'CONSERVATIVE', 'DEFENSIVE', 'AGGRESSIVE', 'BULLISH',
    // extra common words surfaced by typical queries
    'DO', 'OF', 'GIVE', 'ME', 'WANT', 'AN', 'STRATEGY', 'GROWTH',
    'THINK', 'RIGHT', 'GOOD', 'TAKE', 'PLAN', 'TRADE', 'NEED', 'READ',
    'WHAT', 'ABOUT', 'AGAINST', 'COMPARE', 'NOW', 'VIEW', 'LOOK', 'FEEL',
    'IS', 'A', 'THE', 'IT', 'BE', 'THIS', 'THAT', 'WE', 'THEY', 'HE', 'SHE',
    'MY', 'YOUR', 'OUR', 'THEIR', 'WHO', 'WHY', 'WHICH', 'WHEN', 'WHERE',
    'GO', 'OK', 'SURE', 'YEAH', 'LIKE', 'LOVE', 'HATE', 'WORTH', 'BUYING',
  ]);

  const allMatches = q.match(/\b[A-Z]{1,5}\b/g) || [];

  const tickers: string[] = [];
  for (const match of allMatches) {
    if (obviousNonTickers.has(match)) continue;
    if (['A', 'I', 'O'].includes(match)) continue;
    if (match.length < 2) continue;
    tickers.push(match);
  }

  const seen = new Set<string>();
  const uniqueTickers: string[] = [];
  for (const ticker of tickers) {
    if (!seen.has(ticker)) {
      seen.add(ticker);
      uniqueTickers.push(ticker);
    }
  }
  tickers.length = 0;
  tickers.push(...uniqueTickers);

  return { tickers, options };
}
