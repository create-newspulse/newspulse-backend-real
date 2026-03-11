const { spawnSync } = require('node:child_process');

const portArg = String(process.argv[2] || process.env.PORT || '5000').trim();
const port = parseInt(portArg, 10);

function fail(message) {
  console.error(`[free-port] ${message}`);
  process.exit(1);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  fail(`Invalid port: ${portArg}`);
}

function runPowerShell(script) {
  return spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      env: process.env,
      encoding: 'utf8',
    }
  );
}

function getListeningPids(targetPort) {
  if (process.platform !== 'win32') return [];

  const result = runPowerShell(
    `$portPids = Get-NetTCPConnection -LocalPort ${targetPort} -State Listen -ErrorAction SilentlyContinue | ` +
    `Select-Object -ExpandProperty OwningProcess -Unique; ` +
    `if ($null -ne $portPids) { $portPids | ForEach-Object { Write-Output $_ } }`
  );

  if ((result.status ?? 0) !== 0) {
    return [];
  }

  return String(result.stdout || '')
    .split(/\r?\n/g)
    .map((value) => String(value || '').trim())
    .filter((value) => /^\d+$/.test(value))
    .map((value) => Number(value));
}

function getProcessInfo(pid) {
  if (process.platform !== 'win32') return null;

  const result = runPowerShell(
    `$procInfo = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" | ` +
    `Select-Object ProcessId, Name, CommandLine, ExecutablePath | ConvertTo-Json -Compress; ` +
    `if ($null -ne $procInfo) { Write-Output $procInfo }`
  );

  if ((result.status ?? 0) !== 0) return null;

  const output = String(result.stdout || '').trim();
  if (!output) return null;

  try {
    return JSON.parse(output);
  } catch (_) {
    return null;
  }
}

function stopProcess(pid) {
  if (process.platform !== 'win32') return false;

  const result = runPowerShell(`Stop-Process -Id ${pid} -Force -ErrorAction Stop`);
  return (result.status ?? 0) === 0;
}

async function waitForPortToClear(targetPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getListeningPids(targetPort).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return getListeningPids(targetPort).length === 0;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log(`[free-port] Port cleanup is only implemented for Windows in this repo. Skipping port ${port}.`);
    return;
  }

  const pids = getListeningPids(port);
  if (pids.length === 0) {
    console.log(`[free-port] Port ${port} is already free.`);
    return;
  }

  console.log(`[free-port] Releasing port ${port}.`);

  for (const pid of pids) {
    const info = getProcessInfo(pid);
    console.log('[free-port] stopping process', {
      port,
      pid,
      name: info && info.Name ? info.Name : null,
      executablePath: info && info.ExecutablePath ? info.ExecutablePath : null,
    });

    if (!stopProcess(pid)) {
      fail(`Failed to stop PID ${pid} on port ${port}`);
    }
  }

  const cleared = await waitForPortToClear(port, 5000);
  if (!cleared) {
    fail(`Port ${port} is still busy after attempting cleanup.`);
  }

  console.log(`[free-port] Port ${port} is free.`);
}

main().catch((error) => {
  fail(error && error.message ? error.message : String(error));
});