import type { PoolClient } from "pg";
import { config } from "../config.js";

export interface AssignedProxy {
  id: string;
  ipAddress: string;
  countryCode: string;
}

export async function assignDedicatedProxyForUser(params: {
  client: PoolClient;
  userId: string;
  billingCountry?: string | null;
}): Promise<AssignedProxy> {
  const existing = await params.client.query<{
    id: string;
    ip_address: string;
    country_code: string;
  }>(
    `
      select p.id, p.ip_address, p.country_code
      from user_profiles up
      join proxy_pool p on p.id = up.proxy_id
      where up.user_id = $1
      limit 1
    `,
    [params.userId],
  );

  if (existing.rowCount) {
    const row = existing.rows[0]!;
    return {
      id: row.id,
      ipAddress: row.ip_address,
      countryCode: row.country_code,
    };
  }

  const picked = await params.client.query<{
    id: string;
    ip_address: string;
    country_code: string;
  }>(
    `
      select id, ip_address, country_code
      from proxy_pool
      where status = 'AVAILABLE'
        and (
          $1::text is null
          or upper(country_code) = upper($1)
        )
      order by created_at asc
      limit 1
      for update skip locked
    `,
    [params.billingCountry],
  );

  if (!picked.rowCount) {
    const fallback = await params.client.query<{
      id: string;
      ip_address: string;
      country_code: string;
    }>(
      `
        select id, ip_address, country_code
        from proxy_pool
        where status = 'AVAILABLE'
        order by created_at asc
        limit 1
        for update skip locked
      `,
    );

    if (!fallback.rowCount) {
      const countryLabel = params.billingCountry || "the selected user";
      throw new Error(`No dedicated proxy available for ${countryLabel}`);
    }

    picked.rows.push(fallback.rows[0]!);
  }

  const row = picked.rows[0]!;

  await params.client.query(
    `
      update proxy_pool
      set status = 'IN_USE',
          assigned_user_id = $1,
          updated_at = now()
      where id = $2
    `,
    [params.userId, row.id],
  );

  await params.client.query(
    `
      insert into user_profiles (user_id, billing_country, proxy_id, metaapi_region)
      values ($1, $2, $3, $4)
      on conflict (user_id)
      do update set billing_country = excluded.billing_country,
                    metaapi_region = excluded.metaapi_region,
                    proxy_id = excluded.proxy_id,
                    updated_at = now()
    `,
    [params.userId, params.billingCountry ?? row.country_code, row.id, config.METAAPI_REGION],
  );

  return {
    id: row.id,
    ipAddress: row.ip_address,
    countryCode: row.country_code,
  };
}
