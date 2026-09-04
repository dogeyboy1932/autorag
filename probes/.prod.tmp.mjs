import puppeteer from 'puppeteer-core';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const EXT = resolve('extension/dist');
const env = Object.fromEntries(readFileSync('.env2','utf8').split('\n')
  .filter(l=>l.trim()&&!l.startsWith('#')&&l.includes('='))
  .map(l=>[l.slice(0,l.indexOf('=')).trim(), l.slice(l.indexOf('=')+1).trim()]));
const U=env.DIRECTORY_URL.replace(/\/$/,''), SK=env.DIRECTORY_SECRET_KEY;
const admin=(p,i={})=>fetch(`${U}/${p}`,{...i,headers:{apikey:SK,Authorization:`Bearer ${SK}`,'content-type':'application/json',...i.headers}});
const EMAIL=`prod-${Date.now()}@gmail.com`, PW='probe-password-1234';
const made=await (await admin('auth/v1/admin/users',{method:'POST',body:JSON.stringify({email:EMAIL,password:PW,email_confirm:true})})).json();
const SITE='https://autorag-web.netlify.app/';

const b=await puppeteer.launch({executablePath:'/snap/bin/brave',headless:false,
  userDataDir: mkdtempSync(join(tmpdir(),'prod-')),
  args:['--no-first-run',`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`]});
const p=await b.newPage(); const errs=[];
p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
p.on('pageerror',e=>errs.push('pageerror: '+e.message));
await p.goto(SITE,{waitUntil:'networkidle2',timeout:120000});
await new Promise(r=>setTimeout(r,4000));
const login=await p.evaluate(()=>document.body.innerText);
console.log('login screen  :', /Use as guest/.test(login)&&/Demo mode/.test(login)?'shown':'MISSING');

await p.evaluate((e,pw)=>{const ins=[...document.querySelectorAll('input')];
  const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
  set(ins[0],e); set(ins[1],pw);},EMAIL,PW);
await new Promise(r=>setTimeout(r,400));
await p.evaluate(()=>{const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Sign in');el?.click();});
await new Promise(r=>setTimeout(r,12000));
const app=await p.evaluate(()=>document.body.innerText);
console.log('signed in     :', app.includes(EMAIL)?'yes':'NO');
console.log('sessions      :', /Sessions/.test(app)?'shown':'missing');
console.log('public-demo   :', /public-demo/.test(app)?'listed':'not listed');
console.log('extension seen:', /connected|extension is installed/i.test(app)?'yes':'no');
console.log('errors        :', errs.length, errs.slice(0,3).join(' | '));

// Does the panel pick up the production sign-in?
let t; for(let i=0;i<40&&!t;i++){t=b.targets().find(x=>x.url().includes('/background.js')); if(!t) await new Promise(r=>setTimeout(r,250));}
const id=new URL((await t.worker()).url()).host;
const panel=await b.newPage();
await panel.goto(`chrome-extension://${id}/sidepanel.html`);
await panel.waitForFunction(()=>document.body.innerText.includes('model ready'),{timeout:180000}).catch(()=>{});
await panel.evaluate(()=>{const el=[...document.querySelectorAll('button')].find(b=>/settings/i.test(b.textContent));el?.click();});
await new Promise(r=>setTimeout(r,4000));
const pan=await panel.evaluate(()=>document.body.innerText);
console.log('panel account :', pan.includes(EMAIL)?'mirrored from production':'NOT mirrored');
await b.close();
await admin(`rest/v1/profiles?user_id=eq.${made.id}`,{method:'DELETE'});
await admin(`auth/v1/admin/users/${made.id}`,{method:'DELETE'});
console.log('cleaned up');
process.exit(0);
