import { createClient } from '@supabase/supabase-js';

const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL || '').trim();
const publishableKey = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim();

export const supabase = supabaseUrl && publishableKey
  ? createClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
  })
  : null;
