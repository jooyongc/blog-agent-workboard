import asty from "../../sites/asty-cabin/config.json";
import buyList from "../../sites/korea-buy-list/config.json";
import byLocal from "../../sites/koreabylocal/config.json";
import decode from "../../sites/koreadecode/config.json";
import type { Workspace } from "./types";
export const CATALOG: Workspace[] = [
  {
    site_id: asty.site_id,
    name: "ASTY Cabin",
    site_url: asty.site_url,
    languages: asty.languages,
    categories: asty.categories,
    integration: "asty",
    description: "서울 장기 체류자를 위한 숙소·생활 가이드",
    admin_url: `${asty.site_url}/admin`,
  },
  {
    site_id: buyList.site_id,
    name: "Korea Buy List",
    site_url: buyList.site_url,
    languages: buyList.languages,
    categories: buyList.categories,
    integration: "blogger",
    description: "영어·일본어 독자를 위한 한국 쇼핑 가이드",
    admin_url: `https://www.blogger.com/blog/posts/${buyList.bridge.blog_id}`,
  },
  {
    site_id: byLocal.site_id,
    name: "Korea by Local",
    site_url: byLocal.site_url,
    languages: byLocal.languages,
    categories: byLocal.categories,
    integration: "supabase",
    description: "현지의 시선으로 전하는 한국 여행과 경험",
    admin_url: `${byLocal.site_url}/admin/blog`,
  },
  {
    site_id: decode.site_id,
    name: "Korea Decode",
    site_url: decode.site_url,
    languages: decode.languages,
    categories: decode.categories,
    integration: "supabase",
    description: "세계의 독자에게 풀어주는 한국 문화와 트렌드",
    admin_url: `${decode.site_url}/admin/`,
  },
];
export function getWorkspace(id: string) {
  const w = CATALOG.find((w) => w.site_id === id);
  if (!w) throw new Error("Unknown workspace");
  return w;
}
