import { setDefaultResultOrder } from "node:dns";
import { Pool } from "pg";
import { config } from "../config.js";

setDefaultResultOrder("ipv4first");

const databaseUrl = new URL(config.DATABASE_URL);
const isLocalDatabase =
  databaseUrl.hostname === "127.0.0.1" ||
  databaseUrl.hostname === "localhost";

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  ssl: isLocalDatabase ? false : { rejectUnauthorized: false },
  keepAlive: true,
});
