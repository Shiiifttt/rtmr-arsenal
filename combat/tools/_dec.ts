import { decodeBuild } from '../../web/src/share.ts';
for (const l of process.argv.slice(2)) console.log(JSON.stringify(await decodeBuild(l.split('#b=')[1]), null, 1));
