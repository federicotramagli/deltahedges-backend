import { config } from "../config.js";

export type BillingCadence = "Mensile";

export interface BillingPlanDefinition {
  id: string;
  name: string;
  description: string;
  seatCount: number;
  monthlyAmountUsd: number;
  monthlyPerSlotUsd: number;
  cadence: BillingCadence;
  stripePriceId: string | null;
  isTest: boolean;
}

function buildMonthlyPerSlot(monthlyAmountUsd: number, seatCount: number) {
  return Number((monthlyAmountUsd / seatCount).toFixed(2));
}

export function getBillingPlanCatalog(): BillingPlanDefinition[] {
  const catalog: BillingPlanDefinition[] = [
    {
      id: "slots-1-monthly",
      name: "1 Slot",
      description: "Perfetto per iniziare con una sola coppia attiva.",
      seatCount: 1,
      monthlyAmountUsd: 149,
      monthlyPerSlotUsd: buildMonthlyPerSlot(149, 1),
      cadence: "Mensile",
      stripePriceId: config.STRIPE_PRICE_ID_1_SLOT ?? null,
      isTest: false,
    },
    {
      id: "slots-2-monthly",
      name: "2 Slot",
      description: "Per chi vuole gestire due coppie contemporaneamente.",
      seatCount: 2,
      monthlyAmountUsd: 289,
      monthlyPerSlotUsd: buildMonthlyPerSlot(289, 2),
      cadence: "Mensile",
      stripePriceId: config.STRIPE_PRICE_ID_2_SLOTS ?? null,
      isTest: false,
    },
    {
      id: "slots-3-monthly",
      name: "3 Slot",
      description: "Il pacchetto bilanciato per operare con piu coppie.",
      seatCount: 3,
      monthlyAmountUsd: 429,
      monthlyPerSlotUsd: buildMonthlyPerSlot(429, 3),
      cadence: "Mensile",
      stripePriceId: config.STRIPE_PRICE_ID_3_SLOTS ?? null,
      isTest: false,
    },
    {
      id: "slots-5-monthly",
      name: "5 Slot",
      description: "Massima capacita per chi vuole scalare davvero.",
      seatCount: 5,
      monthlyAmountUsd: 629,
      monthlyPerSlotUsd: buildMonthlyPerSlot(629, 5),
      cadence: "Mensile",
      stripePriceId: config.STRIPE_PRICE_ID_5_SLOTS ?? null,
      isTest: false,
    },
  ];

  if (config.STRIPE_PRICE_ID_TEST_SLOT) {
    catalog.push({
      id: "test-slot-monthly",
      name: "Test Slot",
      description: "Piano tecnico per verificare checkout, webhook e attivazione seat.",
      seatCount: 1,
      monthlyAmountUsd: 0,
      monthlyPerSlotUsd: 0,
      cadence: "Mensile",
      stripePriceId: config.STRIPE_PRICE_ID_TEST_SLOT,
      isTest: true,
    });
  }

  return catalog;
}

export function getBillingPlanById(planId: string) {
  return getBillingPlanCatalog().find((plan) => plan.id === planId) ?? null;
}

export function listPublicBillingPlans() {
  return getBillingPlanCatalog().map((plan) => ({
    id: plan.id,
    name: plan.name,
    description: plan.description,
    seatCount: plan.seatCount,
    cadence: plan.cadence,
    monthlyAmountUsd: plan.monthlyAmountUsd,
    monthlyPerSlotUsd: plan.monthlyPerSlotUsd,
    isTest: plan.isTest,
    configured: Boolean(plan.stripePriceId),
  }));
}
