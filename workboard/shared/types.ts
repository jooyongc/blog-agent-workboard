export type Integration = "blogger" | "supabase" | "webhook";
export type Strategy = {
  media_mode?: "stock" | "hybrid";
  generate_video?: boolean;
  audience: string;
  voice: string;
  pillars: string[];
  entities: string[];
  source_domains: string[];
  templates: {
    title: string;
    category: string;
    keyword: string;
    format: string;
    emoji?: string;
    hint?: string;
    group?: string;
    direction?: string;
    tags?: string[];
    aeo?: boolean;
    seasonal_months?: number[];
  }[];
  min_score: number;
  required_images: number;
  affiliate_disclosure: string;
  gsc_url?: string;
  gsc_key_env?: string;
};
export type Connection = {
  url_env: string;
  key_env: string;
  schema?: string;
  table?: string;
  template?: "koreabylocal" | "koreadecode" | "generic";
  blog_id?: string;
  client_id_env?: string;
  client_secret_env?: string;
  refresh_token_env?: string;
};
export type Schedule = {
  owner?: "cloudflare" | "aside";
  enabled: boolean;
  interval_days: number;
  hour_kst: number;
  minute: number;
  next_run: string;
  mode: "draft" | "publish";
  auto_generate: boolean;
};
export type Workspace = {
  site_id: string;
  name: string;
  site_url: string;
  article_path?: string;
  site_url_env?: string;
  languages: string[];
  categories: string[];
  integration: Integration;
  description: string;
  admin_url: string;
  strategy: Strategy;
  connection: Connection;
  schedule: Schedule;
};
export type Post = {
  id: string;
  slug: string;
  title: string;
  categoryId: string;
  canonicalLang: string;
  status: "draft" | "published" | "scheduled" | "archived";
  createdAt: string;
  updatedAt: string;
  publishAt: string | null;
  publishedAt: string | null;
  url?: string;
};
export type PostsResult = { posts: Post[]; warning?: string; error?: string };
export type Article = {
  videos?: {
    id: string;
    provider: string;
    url: string;
    page: string;
    alt: string;
  }[];
  images?: {
    id: string;
    provider:
      "Pexels" | "Unsplash" | "Adobe Stock" | "Adobe Firefly" | "Gemini";
    url: string;
    page: string;
    photographer: string;
    photographer_url: string;
    alt: string;
    license_url: string;
    visual_review?: {
      approved: boolean;
      reason: string;
      model: string;
      run_id: string;
      sha256: string;
      policy?: string;
    };
  }[];
  title: string;
  meta_description: string;
  tags: string[];
  content_md: string;
  source_notes?: string;
  primary_keyword?: string;
  secondary_keywords?: string[];
  format?: string;
  faq?: { question: string; answer: string }[];
};
export type DraftInput = {
  request_id: string;
  site_id: string;
  slug: string;
  category: string;
  translations: Record<string, Article>;
  featured_image_url?: string;
  reviewed: boolean;
};
export type Quality = {
  score: number;
  passed: boolean;
  issues: string[];
  signals: Record<string, boolean | number>;
  faq: { question: string; answer: string }[];
};
