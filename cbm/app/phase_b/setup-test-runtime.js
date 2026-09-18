'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
async function main(){
  const dir=path.join(__dirname,'.test-runtime');
  const archive=path.join(dir,'pglite-0.5.8.tgz');
  const target=path.join(dir,'pglite');
  const hash='d71088d246d86e946c5d53b152a23c6b79ee65c8bc43dab69670af53b57c788d';
  if(fs.existsSync(path.join(target,'dist','index.cjs')))return console.log('PostgreSQL test runtime is already installed.');
  fs.mkdirSync(dir,{recursive:true});
  if(!fs.existsSync(archive)){
    const response=await fetch('https://registry.npmjs.org/@electric-sql/pglite/-/pglite-0.5.8.tgz');
    if(!response.ok)throw new Error('Package download failed: '+response.status);
    fs.writeFileSync(archive,Buffer.from(await response.arrayBuffer()));
  }
  if(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')!==hash)throw new Error('Test package integrity mismatch.');
  fs.mkdirSync(target,{recursive:true});
  execFileSync('tar',['-xzf',archive,'-C',target,'--strip-components=1'],{stdio:'inherit',windowsHide:true});
  console.log('Installed isolated PGlite 0.5.8 test runtime. No production database touched.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
