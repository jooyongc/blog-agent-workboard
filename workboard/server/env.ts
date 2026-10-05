export type Env = {
  WORKBOARD_DB: D1Database;
  DASHBOARD_PASSWORD: string;
  DASHBOARD_SESSION_SECRET: string;
  NATIVE_BLOG_SUPABASE_URL?: string;
  NATIVE_BLOG_SUPABASE_KEY?: string;
  ASTY_SITE_URL?: string;
  ASTY_AGENT_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  AI_ENABLED?: string;
};
export type Context = {
  request: Request;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
};
