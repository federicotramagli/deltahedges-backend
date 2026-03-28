import { Router } from "express";
import {
  calculateBrokerLot,
  getChallengeAccountSize,
  getEffectiveMultiplier,
  type ChallengeName,
} from "@deltahedge/shared";
import { z } from "zod";
import { requireAuth } from "../auth/supabase-auth.js";
import type { AuthedRequest } from "../types/http.js";
import {
  getMetaApiOpenPositions,
  getMetaApiAccountLiveMetrics,
  getMetaApiAccountConnectionSnapshot,
  getMetaApiSymbolPrice,
  getMetaApiSymbolSpecification,
  closeMetaApiPositions,
  submitMetaApiTrade,
  updateMetaApiPositionProtection,
  waitForMetaApiPosition,
} from "../services/metaapi-service.js";
import {
  closeOpenTradePairForSlot,
  getSlotById,
  getOpenTradePairForSlot,
  getStoredSlotAccounts,
  recordOpenedTradePair,
} from "../services/slot-service.js";
import { logger } from "../logger.js";

const debugTestExecutionSchema = z.object({
  slotId: z.string().min(1),
  challenge: z.custom<ChallengeName>(),
  phase: z.enum(["Fase 1", "Fase 2", "Funded"]),
  hedgeBaseTarget: z.coerce.number().positive(),
  symbol: z.string().trim().min(1).default("XAUUSD"),
  direction: z.enum(["BUY", "SELL"]).default("BUY"),
  propLot: z.coerce.number().positive().min(0.8).max(2).default(1),
  brokerLotStep: z.coerce.number().positive().default(0.01),
  existingPropMetaApiAccountId: z.string().optional().nullable(),
  existingBrokerMetaApiAccountId: z.string().optional().nullable(),
  prop: z
    .object({
      platform: z.enum(["mt4", "mt5"]).optional().default("mt5"),
      login: z.string().optional().default(""),
      password: z.string().optional().default(""),
      server: z.string().optional().default(""),
    })
    .optional(),
  broker: z
    .object({
      platform: z.enum(["mt4", "mt5"]).optional().default("mt5"),
      login: z.string().optional().default(""),
      password: z.string().optional().default(""),
      server: z.string().optional().default(""),
      accountName: z.string().optional().default("Broker demo"),
    })
    .optional(),
});

const debugConnectionStatusSchema = z.object({
  slotId: z.string().min(1),
  existingPropMetaApiAccountId: z.string().optional().nullable(),
  existingBrokerMetaApiAccountId: z.string().optional().nullable(),
  prop: z
    .object({
      platform: z.enum(["mt4", "mt5"]).optional().default("mt5"),
      login: z.string().optional().default(""),
      password: z.string().optional().default(""),
      server: z.string().optional().default(""),
    })
    .optional(),
  broker: z
    .object({
      platform: z.enum(["mt4", "mt5"]).optional().default("mt5"),
      login: z.string().optional().default(""),
      password: z.string().optional().default(""),
      server: z.string().optional().default(""),
      accountName: z.string().optional().default("Broker demo"),
    })
    .optional(),
});

export const debugRouter = Router();
debugRouter.use(requireAuth);
const activeExecutionTests = new Set<string>();

async function withStage<T>(stage: string, task: () => Promise<T>) {
  try {
    return await task();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown execution error";
    throw new Error(`${stage}: ${message}`);
  }
}

function toLiveMetricsSideSnapshot(
  metrics: Awaited<ReturnType<typeof getMetaApiAccountLiveMetrics>> | null,
) {
  if (!metrics) {
    return {
      ...emptySideSnapshot(),
      balance: null,
      equity: null,
      unrealizedPnl: null,
    };
  }

  return {
    state: mapConnectionState(metrics),
    deploymentState: metrics.deploymentState,
    connectionStatus: metrics.connectionStatus,
    region: metrics.region,
    balance: metrics.balance,
    equity: metrics.equity,
    unrealizedPnl: metrics.unrealizedPnl,
  };
}

async function resolveDebugSlotAccounts(
  userId: string,
  parsed:
    | z.infer<typeof debugTestExecutionSchema>
    | z.infer<typeof debugConnectionStatusSchema>,
) {
  let storedAccounts: Awaited<ReturnType<typeof getStoredSlotAccounts>> = {
    prop: null,
    broker: null,
  };

  try {
    storedAccounts = await getStoredSlotAccounts(userId, parsed.slotId);
  } catch (error) {
    logger.warn(
      {
        slotId: parsed.slotId,
        userId,
        error,
      },
      "Stored slot accounts unavailable, falling back to request credentials",
    );
  }

  return {
    storedAccounts,
  };
}

function isMetaApiAccountMissing(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /not found/i.test(message);
}

function mapConnectionState(snapshot: {
  deploymentState: string;
  connectionStatus: string;
}) {
  if (snapshot.connectionStatus === "CONNECTED") return "connected";
  if (
    snapshot.connectionStatus === "ACCOUNT_FAILED" ||
    snapshot.connectionStatus === "BROKER_CONNECTION_FAILED" ||
    snapshot.connectionStatus === "DISCONNECTED_FROM_BROKER"
  ) {
    return "disconnected";
  }
  return "connecting";
}

function emptySideSnapshot() {
  return {
    state: "empty" as const,
    deploymentState: "NOT_PROVISIONED",
    connectionStatus: "NOT_PROVISIONED",
    region: null as string | null,
  };
}

async function readStoredMetaApiAccountSnapshot(accountId?: string | null) {
  if (!accountId) {
    return null;
  }

  try {
    return await getMetaApiAccountConnectionSnapshot(accountId);
  } catch (error) {
    if (isMetaApiAccountMissing(error)) {
      return null;
    }
    throw error;
  }
}

function assertAccountConnected(
  side: "prop" | "broker",
  snapshot: { accountId: string; connectionStatus: string; deploymentState: string },
) {
  if (snapshot.connectionStatus === "CONNECTED") return;

  throw new Error(
    `${side} not connected: MetaApi account ${snapshot.accountId} is ${snapshot.connectionStatus} (${snapshot.deploymentState})`,
  );
}

function buildPropProtectionBudget(params: {
  challenge: ChallengeName;
  phase: "Fase 1" | "Fase 2" | "Funded";
  riskPerTrade: number;
  currentEquity: number;
}) {
  const startingBalance = getChallengeAccountSize(params.challenge);
  const stopFloorEquity = startingBalance * (1 - params.riskPerTrade / 100);
  const targetEquity =
    params.phase === "Fase 1"
      ? Number((startingBalance * 1.08).toFixed(2))
      : params.phase === "Fase 2"
        ? Number((startingBalance * 1.05).toFixed(2))
        : null;
  const stopLossCurrency = Number(
    Math.max(0, params.currentEquity - stopFloorEquity).toFixed(2),
  );
  const takeProfitCurrency =
    targetEquity === null
      ? null
      : Number(Math.max(0, targetEquity - params.currentEquity).toFixed(2));

  return {
    startingBalance,
    stopFloorEquity: Number(stopFloorEquity.toFixed(2)),
    currentEquity: Number(params.currentEquity.toFixed(2)),
    targetEquity,
    stopLossCurrency,
    takeProfitCurrency,
  };
}

function roundPriceToTick(
  price: number,
  tickSize: number,
  mode: "up" | "down",
) {
  const scaled = price / tickSize;
  const rounded =
    mode === "up" ? Math.ceil(scaled + 1e-9) : Math.floor(scaled - 1e-9);
  return Number((rounded * tickSize).toFixed(6));
}

function buildAbsoluteProtectionLevels(params: {
  entryPrice: number;
  direction: "BUY" | "SELL";
  volume: number;
  tickSize: number;
  profitTickValue: number;
  lossTickValue: number;
  stopLossCurrency: number;
  takeProfitCurrency: number | null;
}) {
  if (params.volume <= 0) {
    throw new Error("Invalid prop volume for protection calculation");
  }

  if (params.tickSize <= 0) {
    throw new Error("Invalid tick size for protection calculation");
  }

  if (params.lossTickValue <= 0 || params.profitTickValue <= 0) {
    throw new Error("Invalid tick values for protection calculation");
  }

  const stopLossDistance =
    (params.stopLossCurrency * params.tickSize) /
    (params.lossTickValue * params.volume);
  const takeProfitDistance =
    params.takeProfitCurrency === null
      ? null
      : (params.takeProfitCurrency * params.tickSize) /
          (params.profitTickValue * params.volume) +
        params.tickSize * 100;

  const stopLoss =
    params.direction === "BUY"
      ? roundPriceToTick(params.entryPrice - stopLossDistance, params.tickSize, "down")
      : roundPriceToTick(params.entryPrice + stopLossDistance, params.tickSize, "up");
  const takeProfit =
    takeProfitDistance === null
      ? null
      : params.direction === "BUY"
        ? roundPriceToTick(
            params.entryPrice + takeProfitDistance,
            params.tickSize,
            "up",
          )
        : roundPriceToTick(
            params.entryPrice - takeProfitDistance,
            params.tickSize,
            "down",
          );

  return {
    stopLoss,
    takeProfit,
    stopLossDistance: Number(stopLossDistance.toFixed(6)),
    takeProfitDistance:
      takeProfitDistance === null ? null : Number(takeProfitDistance.toFixed(6)),
    takeProfitPoints:
      params.takeProfitCurrency === null
        ? null
        : Number((takeProfitDistance! / params.tickSize).toFixed(2)),
    stopLossPoints: Number((stopLossDistance / params.tickSize).toFixed(2)),
  };
}

async function tryOrphanAbort(input: {
  accountId: string;
  symbol: string;
  originalDirection: "BUY" | "SELL";
  volume: number;
}) {
  try {
    await submitMetaApiTrade({
      accountId: input.accountId,
      symbol: input.symbol,
      direction: input.originalDirection === "BUY" ? "SELL" : "BUY",
      volume: input.volume,
      retries: 3,
      delayMs: 2000,
    });
    return true;
  } catch (error) {
    logger.error(
      {
        accountId: input.accountId,
        symbol: input.symbol,
        volume: input.volume,
        error,
      },
      "Debug orphan abort failed",
    );
    return false;
  }
}

debugRouter.post("/connection-status", async (request, response, next) => {
  const authedRequest = request as AuthedRequest;
  const parsed = debugConnectionStatusSchema.parse(request.body);

  void (async () => {
    const { storedAccounts } =
      await resolveDebugSlotAccounts(authedRequest.auth.userId, parsed);

    const propAccountId =
      parsed.existingPropMetaApiAccountId || storedAccounts.prop?.metaapiAccountId || null;
    const brokerAccountId =
      parsed.existingBrokerMetaApiAccountId ||
      storedAccounts.broker?.metaapiAccountId ||
      null;

    const [propStatus, brokerStatus] = await Promise.all([
      withStage("prop connection status", () => readStoredMetaApiAccountSnapshot(propAccountId)),
      withStage("broker connection status", () =>
        readStoredMetaApiAccountSnapshot(brokerAccountId),
      ),
    ]);

    response.json({
      propMetaApiAccountId: propAccountId,
      brokerMetaApiAccountId: brokerAccountId,
      prop: propStatus
        ? {
            state: mapConnectionState(propStatus),
            deploymentState: propStatus.deploymentState,
            connectionStatus: propStatus.connectionStatus,
            region: propStatus.region,
          }
        : emptySideSnapshot(),
      broker: brokerStatus
        ? {
            state: mapConnectionState(brokerStatus),
            deploymentState: brokerStatus.deploymentState,
            connectionStatus: brokerStatus.connectionStatus,
            region: brokerStatus.region,
          }
        : emptySideSnapshot(),
    });
  })().catch(next);
});

debugRouter.post("/live-metrics", async (request, response, next) => {
  const authedRequest = request as AuthedRequest;
  const parsed = debugConnectionStatusSchema.parse(request.body);

  void (async () => {
    const { storedAccounts } =
      await resolveDebugSlotAccounts(authedRequest.auth.userId, parsed);

    const propAccountId =
      parsed.existingPropMetaApiAccountId || storedAccounts.prop?.metaapiAccountId || null;
    const brokerAccountId =
      parsed.existingBrokerMetaApiAccountId ||
      storedAccounts.broker?.metaapiAccountId ||
      null;

    const [propMetrics, brokerMetrics] = await Promise.allSettled([
      propAccountId
        ? withStage("prop live metrics", () => getMetaApiAccountLiveMetrics(propAccountId))
        : Promise.resolve(null as Awaited<ReturnType<typeof getMetaApiAccountLiveMetrics>> | null),
      brokerAccountId
        ? withStage("broker live metrics", () => getMetaApiAccountLiveMetrics(brokerAccountId))
        : Promise.resolve(null as Awaited<ReturnType<typeof getMetaApiAccountLiveMetrics>> | null),
    ]);

    const warnings = [propMetrics, brokerMetrics]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => {
        const reason = result.reason;
        return reason instanceof Error ? reason.message : String(reason);
      });

    response.json({
      propMetaApiAccountId: propAccountId,
      brokerMetaApiAccountId: brokerAccountId,
      prop: toLiveMetricsSideSnapshot(
        propMetrics.status === "fulfilled" ? propMetrics.value : null,
      ),
      broker: toLiveMetricsSideSnapshot(
        brokerMetrics.status === "fulfilled" ? brokerMetrics.value : null,
      ),
      warnings,
      fetchedAt: new Date().toISOString(),
    });
  })().catch(next);
});

debugRouter.post("/test-execution", async (request, response, next) => {
  const authedRequest = request as AuthedRequest;
  const parsed = debugTestExecutionSchema.parse(request.body);
  const testKey = `${authedRequest.auth.userId}:${parsed.slotId}`;
  if (activeExecutionTests.has(testKey)) {
    response.status(409).json({
      error: "A test execution is already running for this slot",
    });
    return;
  }
  activeExecutionTests.add(testKey);
  logger.info(
    {
      userId: authedRequest.auth.userId,
      slotId: parsed.slotId,
      challenge: parsed.challenge,
      phase: parsed.phase,
    },
    "Debug test-execution request received",
  );
  const { storedAccounts } = await resolveDebugSlotAccounts(
    authedRequest.auth.userId,
    parsed,
  );

  const propAccountId =
    parsed.existingPropMetaApiAccountId || storedAccounts.prop?.metaapiAccountId || null;
  const brokerAccountId =
    parsed.existingBrokerMetaApiAccountId ||
    storedAccounts.broker?.metaapiAccountId ||
    null;

  if (!propAccountId || !brokerAccountId) {
    activeExecutionTests.delete(testKey);
    response.status(409).json({
      error:
        "Save slot connections first. This slot does not have both MetaApi account ids saved yet.",
    });
    return;
  }

  const existingOpenPair = await getOpenTradePairForSlot(
    authedRequest.auth.userId,
    parsed.slotId,
  );
  if (existingOpenPair) {
    const [propOpenPositions, brokerOpenPositions] = await Promise.all([
      getMetaApiOpenPositions(propAccountId, { symbol: existingOpenPair.symbol }),
      getMetaApiOpenPositions(brokerAccountId, { symbol: existingOpenPair.symbol }),
    ]);

    if (propOpenPositions.length === 0 && brokerOpenPositions.length === 0) {
      await closeOpenTradePairForSlot(authedRequest.auth.userId, parsed.slotId, {
        tradePairId: existingOpenPair.id,
        reason: "Stale open trade pair cleaned before new test execution",
      });
    } else {
      activeExecutionTests.delete(testKey);
      response.status(409).json({
        error: `This slot already has an open trade pair on ${existingOpenPair.symbol} (${existingOpenPair.direction}). Close it first before running another test.`,
      });
      return;
    }
  }

  const propLot = Number(parsed.propLot.toFixed(2));
  const brokerLot = calculateBrokerLot({
    propLot,
    brokerMultiplier: getEffectiveMultiplier({
      challenge: parsed.challenge,
      phase: parsed.phase,
      phase1BaseTarget: parsed.hedgeBaseTarget,
    }),
    brokerLotStep: parsed.brokerLotStep,
  });
  const propDirection = parsed.direction;
  const brokerDirection = propDirection === "BUY" ? "SELL" : "BUY";
  const symbol = parsed.symbol.trim().toUpperCase();
  const slotSnapshot = await getSlotById(authedRequest.auth.userId, parsed.slotId).catch(
    () => null,
  );
  const riskPerTrade = slotSnapshot?.riskPerTrade ?? 1.5;

  void (async () => {
    const [propSnapshot, brokerSnapshot, propPreTradeMetrics, existingPropPositions] =
      await Promise.all([
      withStage("prop status", () => getMetaApiAccountConnectionSnapshot(propAccountId)),
      withStage("broker status", () => getMetaApiAccountConnectionSnapshot(brokerAccountId)),
      withStage("prop pre-trade metrics", () => getMetaApiAccountLiveMetrics(propAccountId)),
      withStage("prop existing positions", () =>
        getMetaApiOpenPositions(propAccountId, { symbol }),
      ),
    ]);

    await withStage("prop connected check", async () => {
      assertAccountConnected("prop", propSnapshot);
    });
    await withStage("broker connected check", async () => {
      assertAccountConnected("broker", brokerSnapshot);
    });

    if (propPreTradeMetrics.equity === null) {
      throw new Error("Prop live equity unavailable. Wait for a stable MetaApi connection.");
    }

    const propProtectionBudget = buildPropProtectionBudget({
      challenge: parsed.challenge,
      phase: parsed.phase,
      riskPerTrade,
      currentEquity: propPreTradeMetrics.equity,
    });

    if (propProtectionBudget.takeProfitCurrency !== null &&
        propProtectionBudget.takeProfitCurrency <= 0) {
      throw new Error(
        `Prop equity is already at or above the ${parsed.phase} target (${propPreTradeMetrics.equity.toFixed(2)} >= ${propProtectionBudget.targetEquity?.toFixed(2) ?? "target"})`,
      );
    }

    if (propProtectionBudget.stopLossCurrency <= 0) {
      throw new Error(
        `Prop equity is already at or below the configured risk floor (${propPreTradeMetrics.equity.toFixed(2)} <= ${propProtectionBudget.stopFloorEquity.toFixed(2)})`,
      );
    }

    const [propTradeResult, brokerTradeResult] = await Promise.allSettled([
      withStage("prop trade", () =>
        submitMetaApiTrade({
          accountId: propAccountId,
          symbol,
          direction: propDirection,
          volume: propLot,
        }),
      ),
      withStage("broker trade", () =>
        submitMetaApiTrade({
          accountId: brokerAccountId,
          symbol,
          direction: brokerDirection,
          volume: brokerLot.rounded,
        }),
      ),
    ]);

    if (
      propTradeResult.status === "fulfilled" &&
      brokerTradeResult.status === "fulfilled"
    ) {
      let propProtectionLevels:
        | ReturnType<typeof buildAbsoluteProtectionLevels>
        | null = null;
      let propPositionId: string | null = null;

      try {
        const [propPosition, propSymbolPrice, propSymbolSpecification] =
          await Promise.all([
            withStage("prop position tracking", () =>
              waitForMetaApiPosition(propAccountId, {
                symbol,
                direction: propDirection,
                excludePositionIds: existingPropPositions.map((position) => position.id),
                retries: 30,
                delayMs: 500,
              }),
            ),
            withStage("prop symbol price", () =>
              getMetaApiSymbolPrice(propAccountId, symbol),
            ),
            withStage("prop symbol specification", () =>
              getMetaApiSymbolSpecification(propAccountId, symbol),
            ),
          ]);

        if (propPosition.openPrice === null) {
          throw new Error("Prop open price unavailable after trade execution");
        }

        propPositionId = propPosition.id;
        propProtectionLevels = buildAbsoluteProtectionLevels({
          entryPrice: propPosition.openPrice,
          direction: propDirection,
          volume: propLot,
          tickSize: propSymbolSpecification.tickSize,
          profitTickValue: propSymbolPrice.profitTickValue,
          lossTickValue: propSymbolPrice.lossTickValue,
          stopLossCurrency: propProtectionBudget.stopLossCurrency,
          takeProfitCurrency: propProtectionBudget.takeProfitCurrency,
        });

        const protectionLevels = propProtectionLevels;

        await withStage("prop protection update", () =>
          updateMetaApiPositionProtection({
            accountId: propAccountId,
            positionId: propPosition.id,
            stopLoss: protectionLevels.stopLoss,
            takeProfit: protectionLevels.takeProfit,
          }),
        );

        await withStage("trade pair persistence", () =>
          recordOpenedTradePair(authedRequest.auth.userId, parsed.slotId, {
            phase: parsed.phase,
            symbol,
            direction: propDirection,
            propTicketId: propPositionId ?? propTradeResult.value.orderId ?? null,
            brokerTicketId: brokerTradeResult.value.orderId ?? null,
            propLotSize: propLot,
            brokerLotRaw: brokerLot.raw,
            brokerLotFinal: brokerLot.rounded,
          }),
        );
      } catch (persistenceError) {
        await Promise.allSettled([
          closeMetaApiPositions(propAccountId, { symbol }),
          closeMetaApiPositions(brokerAccountId, { symbol }),
        ]);

        throw persistenceError;
      }

      response.json({
        logs: [
          "Connection successfully established on prop account",
          "Connection successfully established on broker account",
          "Trade test executed on both legs",
        ],
        propMetaApiAccountId: propAccountId,
        brokerMetaApiAccountId: brokerAccountId,
        symbol,
        propDirection,
        brokerDirection,
        propLot,
        brokerLot: brokerLot.rounded,
        propCurrentEquity: propProtectionBudget.currentEquity,
        propTargetEquity: propProtectionBudget.targetEquity,
        propStopFloorEquity: propProtectionBudget.stopFloorEquity,
        propStopLossCurrency: propProtectionBudget.stopLossCurrency,
        propTakeProfitCurrency: propProtectionBudget.takeProfitCurrency,
        propStopLossPrice: propProtectionLevels?.stopLoss ?? null,
        propTakeProfitPrice: propProtectionLevels?.takeProfit ?? null,
        propStopLossPoints: propProtectionLevels?.stopLossPoints ?? null,
        propTakeProfitPoints: propProtectionLevels?.takeProfitPoints ?? null,
        propTrade: propTradeResult.value,
        brokerTrade: brokerTradeResult.value,
      });
      return;
    }

    if (
      propTradeResult.status === "fulfilled" &&
      brokerTradeResult.status === "rejected"
    ) {
      const brokerTradeError = brokerTradeResult.reason;
      const aborted = await tryOrphanAbort({
        accountId: propAccountId,
        symbol,
        originalDirection: propDirection,
        volume: propLot,
      });
      throw new Error(
        `broker trade failed after prop execution. Orphan abort ${
          aborted ? "completed" : "failed"
        }. ${
          brokerTradeError instanceof Error
            ? brokerTradeError.message
            : String(brokerTradeError)
        }`,
      );
    }

    if (
      propTradeResult.status === "rejected" &&
      brokerTradeResult.status === "fulfilled"
    ) {
      const propTradeError = propTradeResult.reason;
      const aborted = await tryOrphanAbort({
        accountId: brokerAccountId,
        symbol,
        originalDirection: brokerDirection,
        volume: brokerLot.rounded,
      });
      throw new Error(
        `prop trade failed after broker execution. Orphan abort ${
          aborted ? "completed" : "failed"
        }. ${
          propTradeError instanceof Error
            ? propTradeError.message
            : String(propTradeError)
        }`,
      );
    }

    const propTradeError =
      propTradeResult.status === "rejected"
        ? propTradeResult.reason
        : new Error("Prop trade did not return a failure reason");
    const brokerTradeError =
      brokerTradeResult.status === "rejected"
        ? brokerTradeResult.reason
        : new Error("Broker trade did not return a failure reason");

    throw new Error(
      `both trades failed. prop: ${
        propTradeError instanceof Error
          ? propTradeError.message
          : String(propTradeError)
      } · broker: ${
        brokerTradeError instanceof Error
          ? brokerTradeError.message
          : String(brokerTradeError)
      }`,
    );
  })()
    .catch(next)
    .finally(() => {
      activeExecutionTests.delete(testKey);
    });
});
