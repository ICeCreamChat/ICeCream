import { existsSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const rootDir = path.resolve(import.meta.dirname, '..');
const serviceDir = path.join(rootDir, 'manim-service');

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
