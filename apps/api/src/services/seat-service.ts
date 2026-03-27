import type { PoolClient } from "pg";

export interface SeatAvailabilitySnapshot {
  slotsIncluded: number;
  usedSlots: number;
  availableSlots: number;
}

export async function getSeatAvailabilityForUser(
  client: PoolClient,
  userId: string,
): Promise<SeatAvailabilitySnapshot> {
  const [activeSeatsResult, usedSeatsResult] = await Promise.all([
    client.query<{ count: string }>(
      `
        select count(*)::text as count
        from subscription_seats
        where user_id = $1
          and status = 'ACTIVE'
      `,
      [userId],
    ),
    client.query<{ count: string }>(
      `
        select count(*)::text as count
        from seat_allocations sa
        join subscription_seats ss on ss.id = sa.seat_id
        where sa.user_id = $1
          and sa.released_at is null
          and ss.status = 'ACTIVE'
      `,
      [userId],
    ),
  ]);

  const slotsIncluded = Number(activeSeatsResult.rows[0]?.count ?? 0);
  const usedSlots = Number(usedSeatsResult.rows[0]?.count ?? 0);

  return {
    slotsIncluded,
    usedSlots,
    availableSlots: Math.max(slotsIncluded - usedSlots, 0),
  };
}

export async function assertAvailableSeatForUser(
  client: PoolClient,
  userId: string,
  errorMessage = "Serve almeno uno slot pagato e disponibile nel tuo abbonamento.",
) {
  const availability = await getSeatAvailabilityForUser(client, userId);
  if (availability.availableSlots <= 0) {
    throw new Error(errorMessage);
  }
  return availability;
}

export async function allocateSeatForSlot(
  client: PoolClient,
  userId: string,
  slotId: string,
) {
  const seatResult = await client.query<{ id: string }>(
    `
      select ss.id
      from subscription_seats ss
      where ss.user_id = $1
        and ss.status = 'ACTIVE'
        and not exists (
          select 1
          from seat_allocations sa
          where sa.seat_id = ss.id
            and sa.released_at is null
        )
      order by ss.seat_number asc
      limit 1
      for update skip locked
    `,
    [userId],
  );

  if (!seatResult.rowCount) {
    throw new Error("Serve almeno uno slot pagato e disponibile nel tuo abbonamento.");
  }

  const seatId = seatResult.rows[0]!.id;

  await client.query(
    `
      insert into seat_allocations (seat_id, user_id, slot_id)
      values ($1, $2, $3)
      on conflict (slot_id)
      do update set
        seat_id = excluded.seat_id,
        released_at = null
    `,
    [seatId, userId, slotId],
  );

  return seatId;
}

export async function releaseSeatForSlot(
  client: PoolClient,
  slotId: string,
) {
  await client.query(
    `
      update seat_allocations
      set released_at = coalesce(released_at, now())
      where slot_id = $1
        and released_at is null
    `,
    [slotId],
  );

  await client.query(
    `
      update hedging_slots
      set seat_id = null,
          updated_at = now()
      where id = $1
    `,
    [slotId],
  );
}
