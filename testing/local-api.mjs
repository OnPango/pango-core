import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const base='http://127.0.0.1:3300';
if(process.env.DIRECT_URL !== 'postgresql://pango_test:pango_test@127.0.0.1:55432/pango_test' || process.env.DATABASE_URL !== process.env.DIRECT_URL) throw Error('Local test database required');
const suffix=randomUUID().slice(0,8), password=randomUUID();
const tenants=['qa-a-'+suffix,'qa-b-'+suffix];
const tokens=[];
async function call(tenant,token,path,body){
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'X-Tenant':tenant,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  const data=await r.json().catch(()=>null);
  return {r,data};
}
function requireStatus(result,status,label){if(result.r.status!==status)throw Error(label+': HTTP '+result.r.status+' '+(result.data?.code||''));return result.data;}
for(const tenant of tenants){
  const email=tenant+'@example.com';
  const args=['exec','tsx','scripts/tenants.ts','create','--subdomain',tenant,'--legal-name',tenant,'--country','CO','--city','Bogota','--business-sector','RETAIL','--team-size','SIZE_1_5','--product-count','COUNT_1_100','--email',email,'--name','QA Owner','--password',password];
  // Windows pnpm.cmd requires shell; all arguments above are fixed or random alphanumeric.
  const p=spawnSync('pnpm',args,{stdio:'inherit',shell:process.platform==='win32'});
  if(p.status!==0)throw Error('Tenant provisioning failed');
  const login=await call(tenant,null,'/auth/login',{email,password});
  requireStatus(login,200,'Login');
  const prefix='pango_access_'+tenant+'=';
  const cookie=login.r.headers.getSetCookie().find(c=>c.startsWith(prefix));
  if(!cookie)throw Error('Access cookie missing');
  tokens.push(decodeURIComponent(cookie.split(';')[0].slice(prefix.length)));
}
const products=[];
for(let i=0;i<2;i++){
  const tenant=tenants[i],token=tokens[i];
  const units=requireStatus(await call(tenant,token,'/units-of-measure'),200,'Units');
  if(!Array.isArray(units)||!units.length)throw Error('No seeded units');
  const category=requireStatus(await call(tenant,token,'/categories',{name:'QA category'}),201,'Category');
  const product=requireStatus(await call(tenant,token,'/products',{sku:'QA-'+suffix+'-'+i,name:'QA product '+i,categoryId:category.id,stockUnitId:units[0].id}),201,'Product');
  products.push(product);
}
const checks=[];
for(let i=0;i<2;i++){
  const own=await call(tenants[i],tokens[i],'/products/'+products[i].id);
  const foreign=await call(tenants[1-i],tokens[i],'/products/'+products[1-i].id);
  checks.push({case:'own product '+i,status:own.r.status,passed:own.r.status===200&&own.data?.sku===products[i].sku});
  checks.push({case:'cross tenant token '+i,status:foreign.r.status,code:foreign.data?.code,passed:foreign.r.status===403&&foreign.data?.code==='TENANT_MISMATCH'});
}
mkdirSync('validation-results',{recursive:true});
const env={...process.env,BASE_URL:base,TENANT:tenants[0],TOKEN:tokens[0],OTHER_TENANT:tenants[1],OTHER_TOKEN:tokens[1],OTHER_PRODUCT_ID:String(products[1].id),TEST_AUTHORIZED:'1'};
const result=spawnSync(process.execPath,['testing/api-check.mjs'],{env,stdio:'inherit'});
const report={commit:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),scope:'local PostgreSQL synthetic tenants, real HTTP API',checks};
writeFileSync('validation-results/local-isolation.json',JSON.stringify(report,null,2));
if(result.status!==0||checks.some(c=>!c.passed))process.exitCode=1;
