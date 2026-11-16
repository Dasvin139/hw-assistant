import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cleanString } from './sanitize.js';

const BIN_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin'];

export const COMMANDS = Object.freeze({
  lscpu: { bin: 'lscpu', args: [] },
  lsblk: { bin: 'lsblk', args: ['-J', '-b', '-o', 'NAME,SIZE,TYPE,MOUNTPOINT,MODEL,ROTA,TRAN,RM'] },
  lspci: { bin: 'lspci', args: ['-mm'] },
  nvidia_smi: {
    bin: 'nvidia-smi',
    args: ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'],
  },
  // Needs root. Handled via a scoped sudoers rule (see README / scripts/install-sudoers.sh).
  dmidecode_memory: { bin: 'dmidecode', args: ['-t', 'memory'], privileged: true },
});

const FILE_ALLOW = [
  /^\/proc\/meminfo$/,
  /^\/proc\/cpuinfo$/,
  /^\/proc\/version$/,
  /^\/etc\/os-release$/,
  /^\/sys\/class\/dmi\/id\/(sys_vendor|product_name|product_version|board_vendor|board_name|bios_vendor|bios_version|bios_date)$/,
  /^\/sys\/class\/power_supply\/BAT[0-9]+\/(capacity|status|energy_full|energy_full_design|charge_full|charge_full_design|cycle_count|technology|manufacturer|model_name)$/,
];

export function isAllowedPath(p) {
  return typeof p === 'string' && !p.includes('..') && FILE_ALLOW.some((re) => re.test(p));
}

export function resolveBinary(name) {
  for (const dir of BIN_DIRS) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* try next directory */
    }
  }
  return null;
}

const SAFE_ENV = { LC_ALL: 'C', LANG: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

export function createSystem({ fixturesDir = null } = {}) {
  const fx = fixturesDir ? path.resolve(fixturesDir) : null;

  function hasCommand(id) {
    const spec = COMMANDS[id];
    if (!spec) return false;
    if (fx) {
      return (
        fs.existsSync(path.join(fx, 'cmd', `${id}.txt`)) || fs.existsSync(path.join(fx, 'cmd', `${id}.denied`))
      );
    }
    return resolveBinary(spec.bin) !== null;
  }

  async function runCommand(id) {
    const spec = COMMANDS[id];
    if (!spec) throw new Error(`Command not allow-listed: ${id}`);

    if (fx) {
      if (fs.existsSync(path.join(fx, 'cmd', `${id}.denied`))) return { ok: false, reason: 'permission_denied' };
      try {
        return { ok: true, stdout: await fs.promises.readFile(path.join(fx, 'cmd', `${id}.txt`), 'utf8') };
      } catch {
        return { ok: false, reason: 'not_installed' };
      }
    }

    const bin = resolveBinary(spec.bin);
    if (!bin) return { ok: false, reason: 'not_installed' };

    let file = bin;
    let args = [...spec.args];
    if (spec.privileged && process.getuid?.() !== 0) {
      // `sudo -n` never prompts: it either matches a NOPASSWD rule or fails immediately.
      const sudo = resolveBinary('sudo');
      if (!sudo) return { ok: false, reason: 'permission_denied' };
      file = sudo;
      args = ['-n', bin, ...spec.args];
    }

    return new Promise((resolve) => {
      execFile(
        file,
        args,
        { timeout: 5000, maxBuffer: 2 * 1024 * 1024, env: SAFE_ENV, shell: false, windowsHide: true },
        (err, stdout, stderr) => {
          if (!err) return resolve({ ok: true, stdout });
          if (err.killed || err.signal === 'SIGTERM') return resolve({ ok: false, reason: 'timeout' });
          if (err.code === 'ENOENT') return resolve({ ok: false, reason: 'not_installed' });
          if (spec.privileged && /permission|password|not allowed|sudoers|a terminal is required/i.test(stderr || '')) {
            return resolve({ ok: false, reason: 'permission_denied' });
          }
          return resolve({ ok: false, reason: 'failed', detail: cleanString(stderr || err.message, 200) });
        },
      );
    });
  }

  async function readFile(p) {
    if (!isAllowedPath(p)) throw new Error(`Path not allow-listed: ${p}`);
    const real = fx ? path.join(fx, 'files', p) : p;
    try {
      return { ok: true, text: await fs.promises.readFile(real, 'utf8') };
    } catch (e) {
      const reason = e.code === 'ENOENT' ? 'not_found' : e.code === 'EACCES' ? 'permission_denied' : 'failed';
      return { ok: false, reason };
    }
  }

  async function listBatteries() {
    const dir = fx ? path.join(fx, 'files/sys/class/power_supply') : '/sys/class/power_supply';
    try {
      return (await fs.promises.readdir(dir)).filter((n) => /^BAT[0-9]+$/.test(n)).sort();
    } catch {
      return [];
    }
  }

  return { runCommand, readFile, listBatteries, hasCommand, fixture: Boolean(fx) };
}
