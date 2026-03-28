import { pool } from "../db/pool.js";
import { assignDedicatedProxyForUser, assignSpecificProxyToUser } from "../services/proxy-service.js";
import { getUserIdByEmail } from "../services/supabase-admin-service.js";

type CliOptions = {
  email?: string;
  userId?: string;
  proxyId?: string;
  billingCountry?: string;
  metaapiRegion?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--email" && next) {
      options.email = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--user-id" && next) {
      options.userId = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--proxy-id" && next) {
      options.proxyId = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--billing-country" && next) {
      options.billingCountry = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--metaapi-region" && next) {
      options.metaapiRegion = next.trim();
      index += 1;
      continue;
    }
  }

  if (!options.email && !options.userId) {
    throw new Error("Provide --email or --user-id");
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const userId = options.userId ?? (await getUserIdByEmail(options.email!));
  const client = await pool.connect();

  try {
    await client.query("begin");

    const proxy = options.proxyId
      ? await assignSpecificProxyToUser({
          proxyId: options.proxyId,
          userId,
          billingCountry: options.billingCountry,
          metaapiRegion: options.metaapiRegion,
          queryable: client,
        })
      : await assignDedicatedProxyForUser({
          client,
          userId,
          billingCountry: options.billingCountry,
        });

    await client.query("commit");
    console.log(
      JSON.stringify(
        {
          userId,
          email: options.email ?? null,
          proxy,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
