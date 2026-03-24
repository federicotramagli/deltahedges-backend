import Stripe from "stripe";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { pauseUserSlotsForBilling } from "./slot-service.js";

export const stripe = new Stripe(config.STRIPE_SECRET_KEY);

type StripeInvoiceWithSubscription = Stripe.Invoice & {
  subscription?: string | Stripe.Subscription | null;
};

function getInvoiceSubscriptionId(invoice: StripeInvoiceWithSubscription) {
  if (!invoice.subscription) return null;
  return typeof invoice.subscription === "string"
    ? invoice.subscription
    : invoice.subscription.id;
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

export async function createCheckoutSession(userId: string, quantity: number) {
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    success_url: config.STRIPE_SUCCESS_URL,
    cancel_url: config.STRIPE_CANCEL_URL,
    line_items: [
      {
        price: config.STRIPE_PRICE_ID,
        quantity,
      },
    ],
    metadata: {
      userId,
      quantity: String(quantity),
    },
    client_reference_id: userId,
    allow_promotion_codes: true,
  });

  return session;
}

export async function handleStripeWebhook(rawBody: Buffer, signature: string | undefined) {
  if (!signature) {
    throw new Error("Missing Stripe signature");
  }

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
      const quantity = retrieved.line_items?.data[0]?.quantity ?? Number(session.metadata?.quantity ?? 1);
      const userId = session.client_reference_id ?? session.metadata?.userId;
      if (!userId || !retrieved.subscription) break;
      const subscriptionId =
        typeof retrieved.subscription === "string"
          ? retrieved.subscription
          : retrieved.subscription.id;

      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `
            insert into subscriptions (
              user_id, stripe_customer_id, stripe_subscription_id,
              billing_country, plan_name, cadence, renewal_date, status
            )
            values ($1, $2, $3, $4, 'Growth', 'Mensile', now() + interval '1 month', 'ACTIVE')
            on conflict (stripe_subscription_id)
            do update set
              stripe_customer_id = excluded.stripe_customer_id,
              billing_country = excluded.billing_country,
              status = 'ACTIVE',
              updated_at = now()
          `,
          [
            userId,
            typeof retrieved.customer === "string" ? retrieved.customer : retrieved.customer?.id,
            subscriptionId,
            retrieved.customer_details?.address?.country ?? null,
          ],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }

      await syncSeats(userId, subscriptionId, quantity);
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

      const result = await pool.query<{ user_id: string }>(
        `
          update subscriptions
          set status = 'PAST_DUE',
              updated_at = now()
          where stripe_subscription_id = $1
          returning user_id
        `,
        [subscriptionId],
      );

      const userId = result.rows[0]?.user_id;
      if (userId) {
        await pool.query(
          `update subscription_seats set status = 'PAST_DUE', updated_at = now() where user_id = $1`,
          [userId],
        );
        await pauseUserSlotsForBilling(userId);
      }
      break;
    }
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const result = await pool.query<{ user_id: string }>(
        `
          update subscriptions
          set status = 'CANCELED',
              updated_at = now()
          where stripe_subscription_id = $1
          returning user_id
        `,
        [subscription.id],
      );
      const userId = result.rows[0]?.user_id;
      if (userId) {
        await pool.query(
          `update subscription_seats set status = 'CANCELED', updated_at = now() where user_id = $1`,
          [userId],
        );
        await pauseUserSlotsForBilling(userId);
      }
      break;
    }
    default:
      break;
  }

  return { received: true };
}
