import seeds from "./seeds.json";
import type { Workspace } from "./types";
export const CATALOG = seeds as Workspace[];
export function getWorkspace(id: string) {
  const w = CATALOG.find((w) => w.site_id === id);
  if (!w) throw new Error("Unknown workspace");
  return w;
}
