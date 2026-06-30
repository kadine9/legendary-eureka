import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

if (!supabaseConfigured) {
  // eslint-disable-next-line no-console
  console.error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Set them in your .env file (see .env.example), " +
    "or in your host's environment variables (e.g. Cloudflare Pages → Settings → Environment variables) and redeploy."
  );
}

// createClient() throws synchronously on an invalid/empty URL, which would
// otherwise crash the whole app before it can render anything. Fall back to
// a stub client whose calls reject with a clear error instead, so the UI can
// still mount and show a helpful message.
function makeStubClient() {
  const err = () => Promise.resolve({ data: null, error: { message: "Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY." } });
  const builder: any = {
    select: () => builder,
    insert: () => builder,
    delete: () => builder,
    order: () => builder,
    limit: () => builder,
    eq: () => builder,
    in: () => builder,
    single: () => err(),
    then: (resolve: any) => err().then(resolve),
  };
  return { from: () => builder };
}

export const supabase: any = supabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : makeStubClient();
