import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const manimRoot = path.join(repoRoot, 'manim-service');
const requirementsPath = path.join(manimRoot, 'requirements.txt');
const venvDir = path.join(manimRoot, '.venv');
const depsHashFile = path.join(venvDir, '.requirements.sha256');

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    const details = stderr || stdout || `Exit code ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${details}`);
  }

  return result;
}

function resolveSystemPython() {
  const candidates = [
    { cmd: 'python', args: ['--version'] },
    { cmd: 'py', args: ['-3', '--version'] },
  ];

  for (const candidate of candidates) {
    const result = spawnSync(candidate.cmd, candidate.args, {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (result.status === 0) {
      return candidate;
    }
  }

  throw new Error('Python 3 was not found in PATH.');
}

function resolveVenvPython() {
  const windowsPath = path.join(venvDir, 'Scripts', 'python.exe');
  const posixPath = path.join(venvDir, 'bin', 'python');
  return existsSync(windowsPath) ? windowsPath : posixPath;
}

function sha256OfFile(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function ensureVenv(systemPython) {
  if (!existsSync(resolveVenvPython())) {
    console.log('[manim-check] Creating virtual environment...');
    runCommand(systemPython.cmd, [...systemPython.args.slice(0, -1), '-m', 'venv', '.venv'], {
      cwd: manimRoot,
      stdio: 'inherit',
    });
  }
}

function ensureDependencies(venvPython, requirementsHash) {
  const previousHash = existsSync(depsHashFile)
    ? readFileSync(depsHashFile, 'utf8').trim()
    : '';

  if (previousHash === requirementsHash) {
    console.log('[manim-check] Dependencies are up to date.');
    return;
  }

  console.log('[manim-check] Installing/updating Manim dependencies...');
  runCommand(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt'], {
    cwd: manimRoot,
    stdio: 'inherit',
  });
  writeFileSync(depsHashFile, `${requirementsHash}\n`, 'utf8');
}

function runImportProbe(venvPython) {
  const probeScript = `
import importlib
import sys

modules = [
    "fastapi",
    "uvicorn",
    "jinja2",
    "websockets",
    "openai",
    "google.generativeai",
    "manim",
    "pydantic",
    "dotenv",
]

missing = []
for module_name in modules:
    try:
        importlib.import_module(module_name)
    except Exception as exc:
        missing.append((module_name, str(exc)))

if missing:
    print("MISSING_OR_BROKEN:")
    for name, err in missing:
        print(f"{name}: {err}")
    sys.exit(1)

print("ALL_IMPORTS_OK")
`;

  runCommand(venvPython, ['-c', probeScript], {
    cwd: manimRoot,
    stdio: 'inherit',
  });
}

function main() {
  if (!existsSync(requirementsPath)) {
    throw new Error(`Missing requirements file: ${requirementsPath}`);
  }

  const systemPython = resolveSystemPython();
  ensureVenv(systemPython);
  const venvPython = resolveVenvPython();
  const requirementsHash = sha256OfFile(requirementsPath);
  ensureDependencies(venvPython, requirementsHash);
  runImportProbe(venvPython);
  console.log('[manim-check] Environment check passed.');
}

try {
  main();
} catch (error) {
  console.error(`[manim-check] ${error.message}`);
  process.exit(1);
}
