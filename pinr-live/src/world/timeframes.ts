/** The candle sizes a chart can ask the server for (the same ones the server draws: `TIMEFRAMES` in server/market.ts). */
export type TF = "1m" | "5m" | "15m" | "1h" | "4h" | "1D";
export const TF_SECONDS: Record<TF, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1D": 86400 };
