import type {Article,Workspace} from "../shared/types";
export type MediaBrief={key:string;title:string;audience:string;sections:string[];section_summaries:{heading:string;excerpt:string}[];article_excerpt:string;time_of_day:string;scenes:string[];avoid:string[]};
export async function mediaBrief(article:Article,w:Workspace):Promise<MediaBrief>{
 const body=article.content_md.replace(/!\[[^\]]*\]\([^)]+\)/g,"").replace(/^\*?(?:Photo:|AI-generated).*$/gm,"").replace(/\[([^\]]+)\]\([^)]+\)/g,"$1");
 const sections=[...body.matchAll(/^## (.+)$/gm)].map(m=>m[1]).filter(s=>!/quick answer|faq|frequently|sources/i.test(s)).slice(0,6);
 const section_summaries=body.split(/(?=^## )/m).filter(block=>/^## /.test(block) && !/^## (?:Quick Answer|Frequently Asked|FAQ|Sources)/i.test(block)).slice(0,6).map(block=>({heading:block.split("\n")[0].replace(/^## /,""),excerpt:block.split("\n").slice(1).join("\n").trim().slice(0,650)}));
 const evening=/evening|after dark|night|sunset|저녁|야간/i.test(article.title);
 const walk=/walk|산책/i.test(article.title);
 const rest=/rest|sit|break|쉬|쉼/i.test(article.title);
 const scenes=evening&&walk&&rest ? [
  "A contemporary Seoul riverside or urban park walking path after sunset, with city lights and a clearly visible rest area beside the path. Show a brief pause during an evening walk, not an unrelated residential social gathering. People are optional and secondary; do not invent an age-specific audience or make seated people the main subject. Do not substitute a hanok alley or an old village.",
  /convenience|ramyeon|noodle|편의점/i.test(body) ? "An evening rest stop at a Seoul riverside convenience-store area: a small table, a simple noodle-cooking station or ramyeon meal, and the lit walking path or river at night in the surrounding context. Frame branding and printed surfaces out while keeping the store/rest-stop purpose recognisable. No generic old alley, residential bench portrait or blank studio." : "A warm contemporary cafe stop beside an evening Seoul walking route, with the after-dark exterior and the practical pause during the walk visible. Preserve the cafe purpose while framing signs and printed menus out."
 ] : sections.slice(0,4).map(section=>`Illustrate this actual article section: ${section}. Use the article excerpt to choose the practical subject and setting. Match ${evening?"the evening/night lighting":"the time and mood described by the article"}; never replace it with generic Korean scenery.`);
 if(!scenes.length)scenes.push("Illustrate the actual practical subject in the supplied article excerpt, not just the title or a generic Korean background.");
 const data={title:article.title,audience:w.strategy.audience,sections,section_summaries,article_excerpt:body.replace(/\n{3,}/g,"\n\n").slice(0,2200),time_of_day:evening?"evening / after sunset":"follow the article",scenes,avoid:["generic Korean scenery that misses the article's purpose","unsupported claims of an exact real venue","arbitrary age stereotypes","two near-identical scene compositions"]};
 // Cosmetic whitespace must not invalidate an already reviewed contextual image.
 const canonical=JSON.stringify(data).replace(/\s+/g," ").trim();
 const key=[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical)))].map(b=>b.toString(16).padStart(2,"0")).join("");
 return {key,...data};
}
export function briefScene(brief:MediaBrief,slot:number){return brief.scenes[slot%brief.scenes.length];}
export function imageRequestId(site:string,slug:string,revision:number,slot:number,variant:number,brief?:MediaBrief){return `${site}-${slug}-gemini-image-${brief?"b"+brief.key.slice(0,16)+"-":""}v${revision}-${slot}-${variant}`;}

export function mediaSearchQuery(article:Article){return [article.primary_keyword || "",article.title,...[...article.content_md.matchAll(/^## (.+)$/gm)].map(m=>m[1])].join(" ");}
