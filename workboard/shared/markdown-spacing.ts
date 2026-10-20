/** Normalize cosmetic spacing outside fenced/indented code, retaining Markdown hard breaks. */
export function normalizeMarkdownSpacing(md:string){
 const output:string[]=[];let fence:string|null=null;let indented=false;
 for(const line of md.split("\n")){
  const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
  if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;output.push(line);continue;}
  if(!fence && line.trim())indented=/^( {4}|\t)/.test(line);
  if(indented && !fence){output.push(line);continue;}
  if(!fence && !line.trim() && output.at(-1)==="")continue;
  output.push(!fence && !line.trim()?"":line);
 }
 return output.join("\n");
}
