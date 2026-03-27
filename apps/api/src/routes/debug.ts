import { Router } from "express";
import {
  calculateBrokerLot,
  getEffectiveMultiplier,
  type ChallengeName,
} from "@deltahedge/shared";
import { z } from "zod";
import { requireAuth } from "../auth/supabase-auth.js";
import type { AuthedRequest } from "../types/http.js";
import {
  getMetaApiAccountLiveMetrics,
  getMetaApiAccountConnectionSnapshot,
  closeMetaApiPositions,
  submitMetaApiTrade,
} from "../services/metaapi-service.js";
import {
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

    const [propMetrics, brokerMetrics] = await Promise.all([
      propAccountId
        ? withStage("prop live metrics", () => getMetaApiAccountLiveMetrics(propAccountId))
        : Promise.resolve(null),
      brokerAccountId
        ? withStage("broker live metrics", () => getMetaApiAccountLiveMetrics(brokerAccountId))
        : Promise.resolve(null),
    ]);

    response.json({
      propMetaApiAccountId: propAccountId,
      brokerMetaApiAccountId: brokerAccountId,
      prop: propMetrics
        ? {
            state: mapConnectionState(propMetrics),
            deploymentState: propMetrics.deploymentState,
            connectionStatus: propMetrics.connectionStatus,
            region: propMetrics.region,
            balance: propMetrics.balance,
            equity: propMetrics.equity,
            unrealizedPnl: propMetrics.unrealizedPnl,
          }
        : {
            ...emptySideSnapshot(),
            balance: null,
            equity: null,
            unrealizedPnl: null,
          },
      broker: brokerMetrics
        ? {
            state: mapConnectionState(brokerMetrics),
            deploymentState: brokerMetrics.deploymentState,
            connectionStatus: brokerMetrics.connectionStatus,
            region: brokerMetrics.region,
            balance: brokerMetrics.balance,
            equity: brokerMetrics.equity,
            unrealizedPnl: brokerMetrics.unrealizedPnl,
          }
        : {
            ...emptySideSnapshot(),
            balance: null,
            equity: null,
            unrealizedPnl: null,
          },
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

  void (async () => {
    const [propSnapshot, brokerSnapshot] = await Promise.all([
      withStage("prop status", () => getMetaApiAccountConnectionSnapshot(propAccountId)),
      withStage("broker status", () => getMetaApiAccountConnectionSnapshot(brokerAccountId)),
    ]);

    await withStage("prop connected check", async () => {
      assertAccountConnected("prop", propSnapshot);
    });
    await withStage("broker connected check", async () => {
      assertAccountConnected("broker", brokerSnapshot);
    });

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
      try {
        await withStage("trade pair persistence", () =>
          recordOpenedTradePair(authedRequest.auth.userId, parsed.slotId, {
            phase: parsed.phase,
            symbol,
            direction: propDirection,
            propTicketId: propTradeResult.value.orderId ?? null,
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
