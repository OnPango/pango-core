// Read-only smoke, tenant isolation and small sequential/concurrent latency test.
import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
const { BASE_URL, TENANT, TOKEN, OTHER_TENANT, OTHER_PRODUCT_ID, OTHER_TOKEN } = process.env;
if (!BASE_URL || !TENANT || !TOKEN || process.env.TEST_AUTHORIZED !== '1')
  throw Error('Set BASE_URL, TENANT, TOKEN and TEST_AUTHORIZED=1 for an authorized test environment');
const base = BASE_URL.replace(/\/$/, '');
const endpoints = ['/auth/me','/products','/warehouses','/categories'];
async function call(path, tenant=TENANT, token=TOKEN) {
  const start = performance.now();
  try {
    const r = await fetch(base+path, {headers:{'X-Tenant':tenant, ...(token?{Authorization:'Bearer '+token}:{})},signal:AbortSignal.timeout(15000),redirect:'error'});
    await r.arrayBuffer();
    return {status:r.status,ms:performance.now()-start};
  } catch { return {status:0,ms:performance.now()-start}; }
}
const checks=[];
for(const path of endpoints) checks.push({path,case:'authorized',...(await call(path)),expected:[200]});
checks.push({path:'/products',case:'missing token',...(await call('/products',TENANT,'')),expected:[401,403]});
if(OTHER_TENANT && OTHER_TOKEN && OTHER_PRODUCT_ID) {
  const path='/products/'+encodeURIComponent(OTHER_PRODUCT_ID);
  checks.push({path,case:'B own resource control',...(await call(path,OTHER_TENANT,OTHER_TOKEN)),expected:[200]});
  checks.push({path,case:'A token with B tenant',...(await call(path,OTHER_TENANT,TOKEN)),expected:[401,403,404]});
}
const metrics=[];
if(checks.every(c=>c.expected.includes(c.status))) {
  for(const path of endpoints) for(const concurrency of [1,5,10]) {
    const samples=[]; const start=performance.now();
    for(let round=0;round<5;round++) {
      samples.push(...await Promise.all(Array.from({length:concurrency},()=>call(path))));
      await new Promise(r=>setTimeout(r,200));
    }
    const elapsed=(performance.now()-start)/1000;
    const sorted=samples.map(s=>s.ms).sort((a,b)=>a-b);
    const pct=p=>sorted[Math.ceil(p*sorted.length)-1];
    metrics.push({path,concurrency,requests:samples.length,p50_ms:pct(.5),p95_ms:pct(.95),error_rate:samples.filter(s=>s.status!==200).length/samples.length,requests_per_second:samples.length/elapsed});
  }
}
mkdirSync('validation-results',{recursive:true});
const report={date:new Date().toISOString(),scope:'read-only short burst, not sustained load',checks,metrics};
writeFileSync('validation-results/api-check.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(checks.some(c=>!c.expected.includes(c.status))||metrics.some(m=>m.error_rate>0)) process.exitCode=1;
