import {defineConfig,configDefaults} from 'vitest/config';
import {fileURLToPath} from 'node:url';
export default defineConfig({
 resolve:{alias:{'@':fileURLToPath(new URL('.',import.meta.url))}},
 test:{exclude:[...configDefaults.exclude,'test/**']}
});
