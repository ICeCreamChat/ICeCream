import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

export function runCommand(command, args, options = {}) {
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

function splitCommandSpec(value) {
  if (!value?.trim()) {
    return null;
  }

  const parts = value.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const [cmd, ...args] = parts.map(part => part.replace(/^"|"$/g, ''));
  return cmd ? { cmd, args } : null;
}

export function resolveSystemPython(env = process.env) {
  const configuredPython = splitCommandSpec(env.PYTHON_CMD) || splitCommandSpec(env.PYTHON);
  const candidates = [
    ...(configuredPython ? [{ cmd: configuredPython.cmd, args: [...configuredPython.args, '--version'] }] : []),
    { cmd: 'py', args: ['-3.12', '--version'] },
    { cmd: 'py', args: ['-3', '--version'] },
    { cmd: 'python', args: ['--version'] },
    { cmd: 'python3', args: ['--version'] },
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

export function resolveVenvPython() {
  const windowsPath = path.join(venvDir, 'Scripts', 'python.exe');
  const posixPath = path.join(venvDir, 'bin', 'python');
  return existsSync(windowsPath) ? windowsPath : posixPath;
}

export function sha256OfFile(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export function ensureVenv(systemPython) {
  if (!existsSync(resolveVenvPython())) {
    console.log('[manim-check] Creating virtual environment...');
    runCommand(systemPython.cmd, [...systemPython.args.slice(0, -1), '-m', 'venv', '.venv'], {
      cwd: manimRoot,
      stdio: 'inherit',
    });
  }
}

export function rebuildVenv(systemPython) {
  const resolvedVenvDir = path.resolve(venvDir);
  const resolvedManimRoot = path.resolve(manimRoot);

  if (!resolvedVenvDir.startsWith(`${resolvedManimRoot}${path.sep}`)) {
    throw new Error(`Refusing to remove unexpected virtualenv path: ${resolvedVenvDir}`);
  }

  if (existsSync(resolvedVenvDir)) {
    console.log('[manim-check] Removing broken Manim virtual environment...');
    rmSync(resolvedVenvDir, { recursive: true, force: true });
  }

  ensureVenv(systemPython);
}

export function buildPipInstallArgs({ force = false } = {}) {
  const args = ['-m', 'pip', 'install'];
  if (force) {
    args.push('--no-cache-dir', '--force-reinstall');
  }
  args.push('-r', 'requirements.txt');
  return args;
}

export function installDependencies(venvPython, { force = false } = {}) {
  runCommand(venvPython, buildPipInstallArgs({ force }), {
    cwd: manimRoot,
    stdio: 'inherit',
  });
}

export function buildImportProbeScript() {
  return `
import importlib
import sys

checks = [
    ("fastapi", "import fastapi"),
    ("uvicorn", "import uvicorn"),
    ("jinja2", "import jinja2"),
    ("websockets", "import websockets"),
    ("openai", "import openai"),
    ("openai.AsyncOpenAI", "from openai import AsyncOpenAI"),
    ("openai.types.shared.OAuthErrorCode", "from openai.types.shared import OAuthErrorCode"),
    ("google.generativeai", "import google.generativeai"),
    ("manim", "import manim"),
    ("pydantic", "import pydantic"),
    ("dotenv", "import dotenv"),
]

missing = []
for module_name, statement in checks:
    try:
        exec(statement, {})
    except Exception as exc:
        missing.append((module_name, str(exc)))

if missing:
    print("MISSING_OR_BROKEN:")
    for name, err in missing:
        print(f"{name}: {err}")
    sys.exit(1)

print("ALL_IMPORTS_OK")
`;
}

export function runImportProbe(venvPython) {
  const probeScript = buildImportProbeScript();
  runCommand(venvPython, ['-c', probeScript], {
    cwd: manimRoot,
    stdio: 'inherit',
  });
}

export function createDependencyEnsurer({
  readPreviousHash,
  installDependencies: install,
  runImportProbe: probe,
  rebuildEnvironment,
  writeCurrentHash,
  log = console.log,
  warn = console.warn,
}) {
  return function ensureDependenciesForHash(requirementsHash) {
    const previousHash = readPreviousHash();
    const rebuildAndInstall = repairError => {
      if (!rebuildEnvironment) {
        throw repairError;
      }

      warn(`[manim-check] Dependency install failed (${repairError.message}). Rebuilding Manim virtual environment...`);
      rebuildEnvironment();
      install({ force: true });
    };

    if (previousHash === requirementsHash) {
      log('[manim-check] Dependencies are up to date.');
    } else {
      log('[manim-check] Installing/updating Manim dependencies...');
      try {
        install({ force: false });
      } catch (installError) {
        rebuildAndInstall(installError);
      }
    }

    try {
      probe();
    } catch (error) {
      warn(`[manim-check] Import probe failed (${error.message}). Reinstalling Manim dependencies without cache...`);
      try {
        install({ force: true });
      } catch (repairError) {
        rebuildAndInstall(repairError);
      }
      probe();
    }

    writeCurrentHash(requirementsHash);
  };
}

export function ensureDependencies(venvPython, requirementsHash, systemPython = resolveSystemPython()) {
  const getVenvPython = () => existsSync(venvPython) ? venvPython : resolveVenvPython();
  const ensureDependenciesForHash = createDependencyEnsurer({
    readPreviousHash: () => existsSync(depsHashFile) ? readFileSync(depsHashFile, 'utf8').trim() : '',
    installDependencies: options => installDependencies(getVenvPython(), options),
    runImportProbe: () => runImportProbe(getVenvPython()),
    rebuildEnvironment: () => rebuildVenv(systemPython),
    writeCurrentHash: hash => writeFileSync(depsHashFile, `${hash}\n`, 'utf8'),
  });

  ensureDependenciesForHash(requirementsHash);
}

export function main() {
  if (!existsSync(requirementsPath)) {
    throw new Error(`Missing requirements file: ${requirementsPath}`);
  }

  const systemPython = resolveSystemPython();
  ensureVenv(systemPython);
  const venvPython = resolveVenvPython();
  const requirementsHash = sha256OfFile(requirementsPath);
  ensureDependencies(venvPython, requirementsHash, systemPython);
  console.log('[manim-check] Environment check passed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    main();
  } catch (error) {
    console.error(`[manim-check] ${error.message}`);
    process.exit(1);
  }
}
