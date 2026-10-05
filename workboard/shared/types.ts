export type Integration = "asty" | "blogger" | "supabase";
export type Workspace = {
  site_id: string;
  name: string;
  site_url: string;
  languages: string[];
  categories: string[];
  integration: Integration;
  description: string;
  admin_url: string;
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
  title: string;
  meta_description: string;
  tags: string[];
  content_md: string;
  source_notes?: string;
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
