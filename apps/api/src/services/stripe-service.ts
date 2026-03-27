import Stripe from "stripe";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { revokeUserBillingAccess } from "./billing-access-service.js";
import {
  getBillingPlanById,
  getBillingPlanCatalog,
  listPublicBillingPlans,
} from "./billing-plan-service.js";

function getStripeClient() {
  if (!config.STRIPE_SECRET_KEY) {
    throw new Error("Stripe not configured");
  }

  return new Stripe(config.STRIPE_SECRET_KEY);
}

type StripeInvoiceWithSubscription = Stripe.Invoice & {
  subscription?: string | Stripe.Subscription | null;
};

function getInvoiceSubscriptionId(invoice: StripeInvoiceWithSubscription) {
  if (!invoice.subscription) return null;
  return typeof invoice.subscription === "string"
    ? invoice.subscription
    : invoice.subscription.id;
}

function getPlanFromStripePriceId(priceId: string | null | undefined) {
  if (!priceId) return null;
  return getBillingPlanCatalog().find((plan) => plan.stripePriceId === priceId) ?? null;
}

function resolveSubscriptionRenewalDate(subscription: Stripe.Subscription | string | null | undefined) {
  if (!subscription || typeof subscription === "string") {
    return null;
  }

  const currentPeriodEnd = subscription.items.data[0]?.current_period_end;
  if (!currentPeriodEnd) {
    return null;
  }

  return new Date(currentPeriodEnd * 1000);
}

async function syncSeats(userId: string, subscriptionId: string, quantity: number) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const subscriptionResult = await client.query<{ id: string }>(
      `select id from subscriptions where stripe_subscription_id = $1 limit 1`,
      [subscriptionId],
    );

    if (!subscriptionResult.rowCount) {
      throw new Error("Subscription not found while syncing seats");
    }

    const localSubscriptionId = subscriptionResult.rows[0]!.id;
    const existing = await client.query<{ id: string; seat_number: number }>(
      `
        select id, seat_number
        from subscription_seats
        where subscription_id = $1
        order by seat_number asc
      `,
      [localSubscriptionId],
    );

    const currentCount = existing.rows.length;
    if (currentCount < quantity) {
      for (let seatNumber = currentCount + 1; seatNumber <= quantity; seatNumber += 1) {
        await client.query(
          `
            insert into subscription_seats (subscription_id, user_id, seat_number, status)
            values ($1, $2, $3, 'ACTIVE')
          `,
          [localSubscriptionId, userId, seatNumber],
        );
      }
    } else if (currentCount > quantity) {
      const toCancel = existing.rows.slice(quantity);
      for (const seat of toCancel) {
        await client.query(
          `update subscription_seats set status = 'CANCELED', updated_at = now() where id = $1`,
          [seat.id],
        );
      }
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function readStripeCustomerIdForUser(userId: string) {
  const result = await pool.query<{ stripe_customer_id: string | null }>(
    `
      select stripe_customer_id
      from subscriptions
      where user_id = $1
        and stripe_customer_id is not null
      order by updated_at desc
      limit 1
    `,
    [userId],
  );

  return result.rows[0]?.stripe_customer_id ?? null;
}

async function markSubscriptionStatus(
  subscriptionId: string,
  status: "ACTIVE" | "PAST_DUE" | "CANCELED",
) {
  return pool.query<{ user_id: string }>(
    `
      update subscriptions
      set status = $2,
          updated_at = now()
      where stripe_subscription_id = $1
      returning user_id
    `,
    [subscriptionId, status],
  );
}

async function syncSeatStatusForUser(
  userId: string,
  status: "ACTIVE" | "PAST_DUE" | "CANCELED",
) {
  await pool.query(
    `
      update subscription_seats
      set status = $2,
          updated_at = now()
      where user_id = $1
    `,
    [userId, status],
  );
}

export function getStripePlans() {
  return {
    configured: Boolean(config.STRIPE_SECRET_KEY),
    plans: listPublicBillingPlans(),
  };
}

export async function createCheckoutSession(userId: string, planId: string) {
  const plan = getBillingPlanById(planId);
  if (!plan) {
    throw new Error("Piano Stripe non riconosciuto.");
  }

  if (!plan.stripePriceId) {
    throw new Error(`Il piano ${plan.name} non e ancora configurato su Stripe.`);
  }

  if (!config.STRIPE_SUCCESS_URL || !config.STRIPE_CANCEL_URL) {
    throw new Error("Stripe checkout not configured");
  }

  const stripe = getStripeClient();
  const stripeCustomerId = await readStripeCustomerIdForUser(userId);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    success_url: config.STRIPE_SUCCESS_URL,
    cancel_url: config.STRIPE_CANCEL_URL,
    line_items: [
      {
        price: plan.stripePriceId,
        quantity: 1,
      },
    ],
    metadata: {
      userId,
      planId: plan.id,
      seatCount: String(plan.seatCount),
      planName: plan.name,
      cadence: plan.cadence,
    },
    client_reference_id: userId,
    allow_promotion_codes: true,
    ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
  });

  return session;
}

export async function handleStripeWebhook(rawBody: Buffer, signature: string | undefined) {
  if (!config.STRIPE_WEBHOOK_SECRET) {
    throw new Error("Stripe webhook not configured");
  }

  if (!signature) {
    throw new Error("Missing Stripe signature");
  }

  const stripe = getStripeClient();
  const event = stripe.webhooks.constructEvent(
    rawBody,
    signature,
    config.STRIPE_WEBHOOK_SECRET,
  );

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const retrieved = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ["line_items.data.price", "subscription", "customer_details"],
      });

      const userId = session.client_reference_id ?? session.metadata?.userId;
      if (!userId || !retrieved.subscription) {
        break;
      }

      const subscriptionId =
        typeof retrieved.subscription === "string"
          ? retrieved.subscription
          : retrieved.subscription.id;

      const priceId =
        retrieved.line_items?.data[0]?.price?.id ??
        (typeof retrieved.subscription !== "string"
          ? retrieved.subscription.items.data[0]?.price.id
          : null);
      const plan =
        getBillingPlanById(session.metadata?.planId ?? "") ??
        getPlanFromStripePriceId(priceId);

      if (!plan) {
        throw new Error("Unable to resolve purchased Stripe plan from checkout session.");
      }

      const renewalDate = resolveSubscriptionRenewalDate(retrieved.subscription);

      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `
            insert into subscriptions (
              user_id, stripe_customer_id, stripe_subscription_id,
              billing_country, plan_name, cadence, renewal_date, status
            )
            values ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')
            on conflict (stripe_subscription_id)
            do update set
              stripe_customer_id = excluded.stripe_customer_id,
              billing_country = excluded.billing_country,
              plan_name = excluded.plan_name,
              cadence = excluded.cadence,
              renewal_date = excluded.renewal_date,
              status = 'ACTIVE',
              updated_at = now()
          `,
          [
            userId,
            typeof retrieved.customer === "string" ? retrieved.customer : retrieved.customer?.id,
            subscriptionId,
            retrieved.customer_details?.address?.country ?? null,
            plan.name,
            plan.cadence,
            renewalDate,
          ],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }

      await syncSeats(userId, subscriptionId, plan.seatCount);
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as StripeInvoiceWithSubscription;
      const subscriptionId = getInvoiceSubscriptionId(invoice);
      if (!subscriptionId) break;

      await pool.query(
        `
          update subscriptions
          set status = 'ACTIVE',
              renewal_date = now() + interval '1 month',
              updated_at = now()
          where stripe_subscription_id = $1
        `,
        [subscriptionId],
      );
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as StripeInvoiceWithSubscription;
      const subscriptionId = getInvoiceSubscriptionId(invoice);
      if (!subscriptionId) break;

      const result = await markSubscriptionStatus(subscriptionId, "PAST_DUE");
      const userId = result.rows[0]?.user_id;
      if (userId) {
        await syncSeatStatusForUser(userId, "PAST_DUE");
        await revokeUserBillingAccess(userId);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const result = await markSubscriptionStatus(subscription.id, "CANCELED");
      const userId = result.rows[0]?.user_id;
      if (userId) {
        await syncSeatStatusForUser(userId, "CANCELED");
        await revokeUserBillingAccess(userId);
      }
      break;
    }

    default:
      break;
  }

  return { received: true };
}
