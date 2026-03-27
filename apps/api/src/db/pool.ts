import { setDefaultResultOrder } from "node:dns";
import { Pool } from "pg";
import { config } from "../config.js";

setDefaultResultOrder("ipv4first");

const databaseUrl = new URL(config.DATABASE_URL);
const isLocalDatabase =
  databaseUrl.hostname === "127.0.0.1" ||
  databaseUrl.hostname === "localhost";

// pg lets ssl-related query params in the connection string override the
// programmatic ssl config. Supabase pooler URLs often include sslmode=require,
// which would discard rejectUnauthorized:false and crash on SELF_SIGNED_CERT_IN_CHAIN.
if (!isLocalDatabase) {
  databaseUrl.searchParams.delete("sslmode");
  databaseUrl.searchParams.delete("sslcert");
  databaseUrl.searchParams.delete("sslkey");
  databaseUrl.searchParams.delete("sslrootcert");
}

export const pool = new Pool({
  connectionString: databaseUrl.toString(),
  max: 10,
  ssl: isLocalDatabase ? false : { rejectUnauthorized: false },
  keepAlive: true,
});
