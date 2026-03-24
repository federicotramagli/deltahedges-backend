import { z } from "zod";
import { challengeCatalog } from "./types.js";

export const challengeEnum = z.enum([
  "FundingPips 25K",
  "FundingPips 50K",
  "FundingPips 100K",
]);

export const phaseEnum = z.enum(["Fase 1", "Fase 2", "Funded"]);

export const createSlotSchema = z.object({
  slot: z.string().trim().min(1).max(64),
  challenge: challengeEnum,
  phase: phaseEnum.default("Fase 1"),
});

export const slotAccountsSchema = z.object({
  challenge: challengeEnum,
  prop: z.object({
    savedAccountId: z.string().uuid().optional().nullable(),
    platform: z.enum(["mt4", "mt5"]).default("mt5"),
    login: z.string().trim().optional().default(""),
    password: z.string().trim().optional().default(""),
    server: z.string().trim().optional().default(""),
  }),
  broker: z.object({
    accountName: z.string().trim().min(1),
    savedAccountId: z.string().uuid().optional().nullable(),
    platform: z.enum(["mt4", "mt5"]).default("mt5"),
    login: z.string().trim().optional().default(""),
    password: z.string().trim().optional().default(""),
    server: z.string().trim().optional().default(""),
    lotStep: z.number().positive().max(1).default(0.01),
  }),
});

export const savedAccountSchema = z.object({
  label: z.string().trim().min(1).max(64),
  accountType: z.enum(["PROP", "BROKER"]),
  platform: z.enum(["mt4", "mt5"]).default("mt5"),
  accountName: z.string().trim().max(64).optional().default(""),
  login: z.string().trim().min(1),
  password: z.string().trim().min(1),
  server: z.string().trim().min(1),
  lotStep: z.number().positive().max(1).default(0.01),
});

export const slotParametersSchema = z.object({
  parametersProfile: z.string().trim().min(1).max(64),
  brokerStartEquity: z.number().positive(),
  hedgeBaseTarget: z.number().positive(),
  riskPerTrade: z.number().positive().max(10),
  maxDailyTrades: z.number().int().min(1).max(2),
  orphanTimeoutMs: z.number().int().min(200).max(5000),
});

export const activateSlotSchema = z.object({
  phase: phaseEnum,
});

export function assertChallengeExists(value: string): asserts value is keyof typeof challengeCatalog {
  if (!(value in challengeCatalog)) {
    throw new Error(`Unsupported challenge: ${value}`);
  }
}
