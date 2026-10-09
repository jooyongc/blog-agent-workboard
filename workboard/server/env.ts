export type Env = {
  MEDIA_POLICY?: string;
  GEMINI_IMAGES_ENABLED?: string;
  [name: string]: unknown;
  SCHEDULER_TOKEN?: string;
  CONNECTION_SECRET?: string;
  AI?: Ai;
  PUBLIC_WORKBOARD_URL?: string;
  WORKBOARD_DB: D1Database;
  DASHBOARD_PASSWORD: string;
  DASHBOARD_SESSION_SECRET: string;
  NATIVE_BLOG_SUPABASE_URL?: string;
  NATIVE_BLOG_SUPABASE_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  AI_WORKER_MODEL?: string;
  AI_REVIEW_MODEL?: string;
  MEDIA_GENERATION_REVISION?: number;
  MEDIA_RECOVERY_REASONS?: string[];
  AI_PROVIDER?: string;
  AI_ENABLED?: string;
};
export type Context = {
  request: Request;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
};
