// Resolve '@sim' the way web/vite.config.ts does, so the web app's share-link
// codec (web/src/share.ts) loads under plain node.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
