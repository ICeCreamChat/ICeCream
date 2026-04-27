import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = dirname(fileURLToPath(import.meta.url));
const gatewayDir = join(configDir, '..');
const projectRoot = join(gatewayDir, '..');

export const gatewayPaths = {
    projectRoot,
    gatewayDir,
    publicDir: join(projectRoot, 'public'),
    uploadsDir: join(projectRoot, 'uploads'),
};
