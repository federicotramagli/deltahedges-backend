import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().default(8080),
  FRONTEND_ORIGIN: z.string().default("http://127.0.0.1:4177"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ENCRYPTION_KEY: z
    .string()
    .min(32, "ENCRYPTION_KEY must be at least 32 chars for AES-256-GCM"),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_ID: z.string().min(1),
  STRIPE_SUCCESS_URL: z.string().url(),
  STRIPE_CANCEL_URL: z.string().url(),
  METAAPI_ACCESS_TOKEN: z.string().optional(),
  METAAPI_REGION: z.string().default("new-york"),
  METAAPI_DEFAULT_PLATFORM: z.enum(["mt4", "mt5"]).default("mt5"),
  METAAPI_ALLOCATE_DEDICATED_IP: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  DEV_USER_ID: z.string().optional(),
});

export type ApiConfig = z.infer<typeof envSchema>;

export const config = envSchema.parse(process.env);
