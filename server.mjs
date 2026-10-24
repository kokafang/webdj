import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('./public/',import.meta.url));
const types={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.mp3':'audio/mpeg','.txt':'text/plain'};
export function createServer(){return http.createServer(async(req,res)=>{
  try{
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(root)||pathname.split('/').some(p=>p.startsWith('.')&&p)){res.writeHead(404);return res.end();}
    const type=types[path.extname(file)];if(!type||!(await stat(file)).isFile()){res.writeHead(404);return res.end();}
    const body=await readFile(file);
    res.writeHead(200,{'Content-Type':type+(type.startsWith('text/')?'; charset=utf-8':''),'Content-Length':body.length,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});
    res.end(req.method==='HEAD'?undefined:body);
  }catch{res.writeHead(404);res.end('Not found');}
});}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||51960),host=process.env.HOST||'127.0.0.1';
  createServer().listen(port,host,()=>console.log(`Jiafeng 的网页 DJ · http://${host}:${port}`));
}
