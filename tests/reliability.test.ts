import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { safeId, option, scheduleKst, reviewHash, requireReview, requireVerification } from '../scripts/_lib/runtime.js';
import { loadSiteConfig } from '../scripts/_lib/config.js';
import { safeContent, buildBundle } from '../scripts/_lib/bridge.js';
const root = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(),'asty-test-'));
function run(script: string, args: string[], cwd: string, env: Record<string,string> = {}) {
  return spawnSync(process.execPath,['--import',path.join(root,'node_modules/tsx/dist/loader.mjs'),path.join(root,'scripts',script),...args],{cwd,encoding:'utf8',env:{...process.env,ANTHROPIC_API_KEY:'',DEEPL_API_KEY:'',ASTY_AGENT_API_KEY:'',...env}});
}
function fixture(site: string, languages: string[]) {
  const cfg = JSON.parse(fs.readFileSync(path.join(root,'sites',site,'config.json'),'utf8'));
  const base=fs.mkdtempSync(path.join(scratch,'fixture-'));
  fs.mkdirSync(path.join(base,'sites',site),{recursive:true});
  fs.writeFileSync(path.join(base,'sites',site,'config.json'),JSON.stringify(cfg));
  const dir=path.join(base,cfg.paths.drafts,'test-post');fs.mkdirSync(dir,{recursive:true});
  const translations: Record<string,unknown>={};
  for(const lang of languages) {
    fs.writeFileSync(path.join(dir,`${lang}.md`),`---\nlang: ${lang}\nauthoring_mode: independent\n---\n## ${lang}\n\nSafe content.`);
    translations[lang]={title:`Title ${lang}`,meta_description:'Reviewed description',tags:['Travel']};
  }
  fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify({slug:'test-post',category:cfg.categories[0],translations}));
  fs.writeFileSync(path.join(dir,'verification.json'),JSON.stringify({overall_status:'partial',summary:{contradicted:0}}));
  return {base,dir,cfg};
}
test('paths and incomplete CLI options are rejected',()=>{
  for(const s of ['../x','a/b','a\\b','','--site','UPPER']) assert.throws(()=>safeId(s));
  assert.throws(()=>option(['--site','--limit=3'],'site'));
  assert.throws(()=>loadSiteConfig('missing-site'));
});
test('KST schedule is UTC midnight two local calendar days ahead',()=>{
  assert.equal(scheduleKst(Date.parse('2026-10-05T16:30:00Z')),'2026-10-08T00:00:00.000Z');
});
test('approval is invalidated by content and metadata changes',()=>{
  const f=fixture('koreabylocal',['en']);
  assert.throws(()=>requireReview(f.dir));
  fs.writeFileSync(path.join(f.dir,'approval.json'),JSON.stringify({hash:reviewHash(f.dir)}));
  requireReview(f.dir);
  fs.appendFileSync(path.join(f.dir,'en.md'),'\nChanged');
  assert.throws(()=>requireReview(f.dir));
});
test('blocked or malformed verification cannot pass',()=>{
  const f=fixture('koreabylocal',['en']);requireVerification(f.dir);
  fs.writeFileSync(path.join(f.dir,'verification.json'),JSON.stringify({overall_status:'verified',summary:{contradicted:1}}));
  assert.throws(()=>requireVerification(f.dir));
});
test('HTML strips executable code while preserving safe Japanese JSON-LD',()=>{
  const out=safeContent('<p onclick="evil()">Hello</p><script>alert(1)</script><img src="javascript:evil()" onerror="evil()"><script type="application/ld+json">{"name":"日本語","description":"</scriptx>"}</script>');
  assert.ok(!out.includes('onclick'));assert.ok(!out.includes('alert'));assert.ok(!out.includes('javascript:'));assert.ok(out.includes('application/ld+json'));assert.ok(out.includes('\\u65e5'));
});
test('Blogger exports English and Japanese independently with correct labels',()=>{
  const f=fixture('korea-buy-list',['en','ja']);const original=process.cwd();
  try {process.chdir(f.base);const bundle=buildBundle('korea-buy-list','test-post');assert.equal(bundle.posts.length,2);assert.deepEqual(bundle.posts.map(p=>p.lang),['en','ja']);assert.ok('labels' in bundle.posts[1].payload && bundle.posts[1].payload.labels.includes('日本語'));}
  finally {process.chdir(original);}
});
test('missing Japanese blocks the complete pair before delivery',()=>{
  const f=fixture('korea-buy-list',['en']);
  const result=run('bridge.ts',['test-post','--site','korea-buy-list','--send'],f.base);
  assert.notEqual(result.status,0);assert.ok(!fs.existsSync(path.join(f.base,'outbox')));
});
test('aside owner prevents accidental API publishing',()=>{
  const f=fixture('korea-buy-list',['en','ja']);
  const result=run('bridge.ts',['test-post','--site','korea-buy-list','--send'],f.base);
  assert.notEqual(result.status,0);assert.match(result.stderr,/aside-browser owns/);
});
test('dry-run makes only GET requests and no paid or local generation',()=>{
  const f=fixture('asty-cabin',[]);const log=path.join(f.base,'requests.jsonl');const mock=path.join(f.base,'mock.mjs');
  fs.writeFileSync(mock,`import fs from 'node:fs'; globalThis.fetch=async(url,opts={})=>{fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({url,method:opts.method??'GET'})+'\\n');return new Response(JSON.stringify(String(url).includes('posts/export')?{posts:[]}:{rows:[{id:'1',title:'Test Topic',category:'culture',seo_score:1}]}),{status:200})};`);
  const result=run('weekly-auto.mts',['--dry-run','--limit=1'],f.base,{ASTY_AGENT_API_KEY:'mock',NODE_OPTIONS:`--import=${mock}`});
  assert.equal(result.status,0,result.stderr);const requests=fs.readFileSync(log,'utf8').trim().split('\n').map(x=>JSON.parse(x));assert.ok(requests.length>0);assert.ok(requests.every(r=>r.method==='GET'));assert.ok(!fs.existsSync(path.join(f.base,'content','.llm-budget.json')));
});
test('duplicate preflight failures stop weekly execution',()=>{
  const f=fixture('asty-cabin',[]);const mock=path.join(f.base,'mock.mjs');fs.writeFileSync(mock,`globalThis.fetch=async url=>new Response(JSON.stringify({rows:[]}),{status:String(url).includes('posts/export')?503:200});`);
  const result=run('weekly-auto.mts',['--dry-run'],f.base,{ASTY_AGENT_API_KEY:'mock',NODE_OPTIONS:`--import=${mock}`});assert.notEqual(result.status,0);assert.match(result.stderr,/Cannot check published slugs/);
});
test('wrong site pipeline is rejected before LLM requests',()=>{
  const f=fixture('koreabylocal',['en']);const result=run('pipeline-run.mts',['--site=koreabylocal','--slug=test','--title=Test','--category=NEWS'],f.base);assert.notEqual(result.status,0);assert.match(result.stderr,/legacy ASTY/);
});
test('blocked legacy draft cannot publish even with an API key',()=>{
  const f=fixture('asty-cabin',['en','ja']);fs.writeFileSync(path.join(f.dir,'verification.json'),JSON.stringify({overall_status:'blocked',summary:{contradicted:1}}));
  const result=run('publish.ts',['test-post'],f.base,{ASTY_AGENT_API_KEY:'mock'});assert.notEqual(result.status,0);assert.match(result.stderr,/blocked verification/);assert.ok(!fs.existsSync(path.join(f.dir,'publish-attempt.json')));
});
test('native adapters never cross schemas or expose public posts by default',()=>{
  for(const site of ['koreabylocal','koreadecode']) {
    const f=fixture(site,['en']);const original=process.cwd();
    try {process.chdir(f.base);const bundle=buildBundle(site,'test-post');assert.equal(bundle.posts.length,1);assert.equal(bundle.posts[0].payload.status,'draft');assert.equal(f.cfg.bridge.schema,site==='koreabylocal'?'koreabylocal':'public');assert.equal(f.cfg.bridge.table,site==='koreabylocal'?'blog_posts':'posts');}
    finally {process.chdir(original);}
  }
});
test('failed delivery is not retried blindly',()=>{
  const f=fixture('koreabylocal',['en']);fs.writeFileSync(path.join(f.dir,'approval.json'),JSON.stringify({hash:reviewHash(f.dir)}));
  const log=path.join(f.base,'requests.jsonl');const mock=path.join(f.base,'mock.mjs');
  fs.writeFileSync(mock,`import fs from 'node:fs';globalThis.fetch=async(url,opts={})=>{fs.appendFileSync(${JSON.stringify(log)},(opts.method??'GET')+'\\n');return new Response(opts.method==='POST'?'server error':'[]',{status:opts.method==='POST'?503:200});};`);
  const env={SUPABASE_SERVICE_ROLE_KEY:'mock',BRIDGE_SUPABASE_URL:'https://agkkvtfwqmzgbrqhvohs.supabase.co',NODE_OPTIONS:`--import=${mock}`};
  assert.notEqual(run('bridge.ts',['test-post','--site=koreabylocal','--send'],f.base,env).status,0);
  assert.notEqual(run('bridge.ts',['test-post','--site=koreabylocal','--send'],f.base,env).status,0);
  assert.equal(fs.readFileSync(log,'utf8').split('\n').filter(x=>x==='POST').length,1);
});
test('delivery replay does not create another remote draft',()=>{
  const f=fixture('koreabylocal',['en']);fs.writeFileSync(path.join(f.dir,'approval.json'),JSON.stringify({hash:reviewHash(f.dir)}));
  const log=path.join(f.base,'requests.jsonl');const mock=path.join(f.base,'mock.mjs');
  fs.writeFileSync(mock,`import fs from 'node:fs';globalThis.fetch=async(url,opts={})=>{fs.appendFileSync(${JSON.stringify(log)},(opts.method??'GET')+'\\n');return new Response(opts.method==='POST'?'[{"id":1,"slug":"test-post","status":"draft"}]':'[]',{status:opts.method==='POST'?201:200});};`);
  const env={SUPABASE_SERVICE_ROLE_KEY:'mock',BRIDGE_SUPABASE_URL:'https://agkkvtfwqmzgbrqhvohs.supabase.co',NODE_OPTIONS:`--import=${mock}`};
  assert.equal(run('bridge.ts',['test-post','--site=koreabylocal','--send'],f.base,env).status,0);
  assert.equal(run('bridge.ts',['test-post','--site=koreabylocal','--send'],f.base,env).status,0);
  assert.equal(fs.readFileSync(log,'utf8').split('\n').filter(x=>x==='POST').length,1);
});
