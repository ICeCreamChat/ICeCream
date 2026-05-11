import { existsSync } from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

const rootDir = path.resolve(import.meta.dirname, '..');
const serviceDir = path.join(rootDir, 'manim-service');
const checkScript = path.join(rootDir, 'scripts', 'check-manim-env.js');

const check = spawnSync(process.execPath, [checkScript], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true
});

if (check.error) {
    console.error(`[manim] Failed to run environment check: ${check.error.message}`);
    process.exit(1);
}

if (check.status !== 0) {
    process.exit(check.status ?? 1);
}

const venvPython = process.platform === 'win32'
    ? path.join(serviceDir, '.venv', 'Scripts', 'python.exe')
    : path.join(serviceDir, '.venv', 'bin', 'python');

const python = existsSync(venvPython)
    ? venvPython
    : (process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'));

const child = spawn(python, ['main.py'], {
    cwd: serviceDir,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true
});

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        if (!child.killed) {
            child.kill(signal);
        }
    });
}
