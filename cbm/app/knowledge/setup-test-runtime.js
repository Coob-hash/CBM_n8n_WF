'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
async function main(){
  execFileSync(process.execPath,[path.join(__dirname,'../phase_b/setup-test-runtime.js')],{stdio:'inherit',windowsHide:true});
  const dir=path.join(__dirname,'../phase_b/.test-runtime/pgvector');
  if(fs.existsSync(path.join(dir,'dist/index.cjs')))return;
  const response=await fetch('https://registry.npmjs.org/@electric-sql/pglite-pgvector/-/pglite-pgvector-0.0.9.tgz');
  if(!response.ok)throw new Error('pgvector download failed');
  const bytes=Buffer.from(await response.arrayBuffer());
  const expected='ue4iBW651gDQwBwn97Ekv1lYGPvXa1ymHbRbTCSL0Ib286PRDD1VDOwzwEoekZuO/wctMbTzKzlwdgDwYrqZ8A==';
  if(crypto.createHash('sha512').update(bytes).digest('base64')!==expected)throw new Error('Package integrity mismatch');
  fs.mkdirSync(dir,{recursive:true});const archive=path.join(dir,'package.tgz');fs.writeFileSync(archive,bytes);
  execFileSync('tar',['-xzf',archive,'-C',dir,'--strip-components=1'],{stdio:'inherit',windowsHide:true});
  console.log('Installed pgvector 0.0.9 for isolated PGlite tests. No install scripts executed.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
