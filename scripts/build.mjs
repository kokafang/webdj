import {cp,mkdir,writeFile} from 'node:fs/promises';
const source=new URL('../public/',import.meta.url),target=new URL('../dist/',import.meta.url);
await mkdir(target,{recursive:true});await cp(source,target,{recursive:true});
await writeFile(new URL('.nojekyll',target),'');
console.log('Static website built in dist/');
