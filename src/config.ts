/** Configuration is validated before a wallet or network client is created. */
export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const value = (name: string, fallback: string) => env[name]?.trim() || fallback;
  const number = (name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const result = Number(value(name, String(fallback)));
    if (!Number.isFinite(result) || result < min || result > max) throw new Error(`Invalid ${name}: expected ${min}..${max}`);
    return result;
  };
  const flag = (name: string, fallback = false) => {
    const v = value(name, String(fallback));
    if (v !== "true" && v !== "false") throw new Error(`Invalid ${name}: expected true or false`);
    return v === "true";
  };
  const mode = value("MODE", "paper");
  if (mode !== "paper" && mode !== "live") throw new Error("MODE must be paper or live");
  const model = value("MODEL", "mock");
  if (model !== "mock" && model !== "jev") throw new Error("MODEL must be mock or jev");
  const dryRun = mode !== "live" || flag("DRY_RUN");
  if (!dryRun && (!flag("LIVE_TRADING_ENABLED") || !env.PRIVATE_KEY || !env.LIVE_AUTHORIZATION_FILE)) {
    throw new Error("Live mode requires LIVE_TRADING_ENABLED=true, PRIVATE_KEY and LIVE_AUTHORIZATION_FILE");
  }
  const bankrollUsd = number("BANKROLL_USD", 10_000, 0.01);
  const result = {
    mode, model: model as "mock" | "jev", dryRun,
    rpcUrl: value("RPC_URL", "https://rpc.monad.xyz"),
    readRpcUrl: value("READ_RPC_URL", "https://rpc.monad.xyz"),
    wsUrl: env.WS_URL || undefined,
    chainId: 143,
    market: value("MARKET", "0x065C9d28E428A0db40191a54d33d5b7c71a9C394"),
    marginAccount: value("MARGIN_ACCOUNT", "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5"),
    privateKey: env.PRIVATE_KEY,
    // Starting a process never deposits or grants token allowances. Pre-fund explicitly.
    marginMon: number("MARGIN_MON", 1_000), marginUsdc: number("MARGIN_USDC", 20),
    tradeSizeMon: number("TRADE_SIZE_MON", 800, 0.000001),
    maxPositionMon: number("MAX_POSITION_MON", 2_000, 0.000001),
    bankrollUsd, quoteInsideTicks: number("QUOTE_INSIDE_TICKS", 1),
    gasLimit: env.GAS_LIMIT ? number("GAS_LIMIT", 650_000, 21_000) : undefined,
    gasLimitFallback: 650_000,
    maxFeeGwei: number("MAX_FEE_GWEI", 400, 0.000001),
    priorityFeeGwei: number("PRIORITY_FEE_GWEI", 2),
    pendingBlocks: 10, refreshBlocks: 200,
    horizonBlocks: number("HORIZON_BLOCKS", 10, 1),
    blockMs: number("BLOCK_MS", 300, 10, 60_000),
    decisionDeadlineMs: number("DECISION_DEADLINE_MS", 250, 1, 60_000),
    rpcTimeoutMs: number("RPC_TIMEOUT_MS", 3_000, 1, 60_000),
    maxDataAgeMs: number("MAX_DATA_AGE_MS", 900, 1),
    maxDailyLossUsd: number("MAX_DAILY_LOSS_USD", bankrollUsd * 0.02, 0.01),
    maxDrawdownFraction: number("MAX_DRAWDOWN_FRACTION", 0.05, 0.000001, 1),
    maxInventoryAgeMs: number("MAX_INVENTORY_AGE_MS", 3_600_000, 1),
    maxApiErrors: number("MAX_API_ERRORS", 5, 1),
    maxLeverage: number("MAX_LEVERAGE", 1, 0.000001),
    jevModelId: value("JEV_MODEL_ID", "jev-1.14.0"),
    typesafeApiKey: env.TYPESAFE_API_KEY || env.TYPESAFE_AI_API_KEY,
    jevUsdPerMTok: number("JEV_USD_PER_MILLION_INPUT_TOKENS", 0.042),
    deterministicFallback: flag("DETERMINISTIC_FALLBACK", true),
    minQuoteLifeMs: number("MIN_QUOTE_LIFE_MS", 5_000),
    maxQuoteLifeMs: number("MAX_QUOTE_LIFE_MS", 30_000, 1),
    repriceBps: number("REPRICE_BPS", 5),
    minSpreadBps: number("MIN_SPREAD_BPS", 10, 0.000001),
    gamma: number("AS_GAMMA", 0.1), kappa: number("AS_KAPPA", 1_000_000, 0.000001),
    quoteHorizonSeconds: number("AS_HORIZON_SECONDS", 30, 0.000001),
    minVolSamples: number("MIN_VOL_SAMPLES", 20, 2),
    expectedFillProbability: number("EXPECTED_FILL_PROBABILITY", 0.1, 0, 1),
    makerFeeBps: number("MAKER_FEE_BPS", 0),
    slippageBps: number("SLIPPAGE_BPS", 1), adverseSelectionBps: number("ADVERSE_SELECTION_BPS", 1),
    maxGasUsdPerHour: number("MAX_GAS_USD_PER_HOUR", 1, 0.000001),
    minNetEdgeUsd: number("MIN_NET_EDGE_USD", 0),
    dataDir: value("DATA_DIR", "data"),
    liveAuthorizationFile: env.LIVE_AUTHORIZATION_FILE,
    reconcileFromBlock: number("RECONCILE_FROM_BLOCK", 0),
    maxReconcileBlocks: number("MAX_RECONCILE_BLOCKS", 10_000, 100),
    port: number("PORT", 3000, 0, 65_535), host: value("HOST", "127.0.0.1"),
    controlToken: env.CONTROL_TOKEN, historySize: 1_000,
  };
  if (result.decisionDeadlineMs >= result.blockMs) throw new Error("DECISION_DEADLINE_MS must be less than BLOCK_MS");
  if (result.maxQuoteLifeMs < result.minQuoteLifeMs) throw new Error("MAX_QUOTE_LIFE_MS must be >= MIN_QUOTE_LIFE_MS");
  if (result.tradeSizeMon > result.maxPositionMon) throw new Error("TRADE_SIZE_MON exceeds MAX_POSITION_MON");
  if (result.priorityFeeGwei > result.maxFeeGwei) throw new Error("PRIORITY_FEE_GWEI exceeds MAX_FEE_GWEI");
  for(const key of ["maxApiErrors","horizonBlocks","minVolSamples","port","reconcileFromBlock","maxReconcileBlocks","quoteInsideTicks"] as const)
    if(!Number.isSafeInteger(result[key]))throw new Error(`${key} must be an integer`);
  if(result.gasLimit!==undefined&&!Number.isSafeInteger(result.gasLimit))throw new Error("GAS_LIMIT must be an integer");
  return result;
}
export const config = loadConfig();
export type Config = ReturnType<typeof loadConfig>;
