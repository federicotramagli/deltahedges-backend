import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";

const supabaseAdmin = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export async function getUserIdByEmail(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error("Email is required");
  }

  let page = 1;

  while (page <= 10) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: 200,
    });

    if (error) {
      throw new Error(error.message || "Unable to resolve user by email");
    }

    const user = data.users.find(
      (candidate) => candidate.email?.trim().toLowerCase() === normalizedEmail,
    );

    if (user?.id) {
      return user.id;
    }

    if (!data.users.length) {
      break;
    }

    page += 1;
  }

  throw new Error(`User ${normalizedEmail} was not found in Supabase auth`);
}
