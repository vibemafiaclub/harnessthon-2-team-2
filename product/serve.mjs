import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
export function serve(dir,port=0) {
  dir=resolve(dir);
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
  const server=createServer((req,res)=>{try{
    const url=new URL(req.url,'http://localhost'),path=resolve(dir,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if(!path.startsWith(dir+sep)||!statSync(path).isFile())throw new Error('Not found');
    res.writeHead(200,{'content-type':types[extname(path)]??'application/octet-stream','cache-control':'no-store'});res.end(readFileSync(path));
  }catch{res.writeHead(404);res.end('Not found');}});
  return new Promise(resolve=>server.listen(port,'127.0.0.1',()=>resolve(server)));
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const server=await serve(process.argv[2],Number(process.argv[3]??4780));console.log(`http://127.0.0.1:${server.address().port}`);
}
