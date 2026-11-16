const UNIT = { b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3, tb: 1024 ** 4, tib: 1024 ** 4 };

export function parseSizeToBytes(str) {
  if (!str) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/i.exec(String(str).trim());
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * UNIT[m[2].toLowerCase()]);
}

function keyValueLines(lines) {
  const kv = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0) {
      const key = line.slice(0, i).trim();
      if (!(key in kv)) kv[key] = line.slice(i + 1).trim(); // first occurrence wins
    }
  }
  return kv;
}

export function parseMeminfo(text) {
  const kb = (name) => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  return { totalBytes: kb('MemTotal'), availableBytes: kb('MemAvailable'), swapBytes: kb('SwapTotal') };
}

export function parseLscpu(text) {
  const kv = keyValueLines(text.split(/\r?\n/));
  const num = (k) => (kv[k] !== undefined && /^\d+$/.test(kv[k]) ? Number(kv[k]) : null);
  const sockets = num('Socket(s)');
  const coresPerSocket = num('Core(s) per socket');
  const maxMhz = kv['CPU max MHz'] ? parseFloat(kv['CPU max MHz']) : null;
  return {
    model: kv['Model name'] ?? null,
    vendor: kv['Vendor ID'] ?? null,
    architecture: kv['Architecture'] ?? null,
    logical_cpus: num('CPU(s)'),
    sockets,
    cores_per_socket: coresPerSocket,
    physical_cores: sockets != null && coresPerSocket != null ? sockets * coresPerSocket : null,
    threads_per_core: num('Thread(s) per core'),
    max_ghz: maxMhz ? parseFloat((maxMhz / 1000).toFixed(2)) : null,
    cache: {
      l1d: kv['L1d cache'] ?? null,
      l2: kv['L2 cache'] ?? null,
      l3: kv['L3 cache'] ?? null,
    },
    virtualization: kv['Virtualization'] ?? null,
  };
}

export function parseProcCpuinfo(text) {
  const model = /^model name\s*:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const logical = (text.match(/^processor\s*:/gm) || []).length || null;
  return {
    model,
    vendor: /^vendor_id\s*:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null,
    architecture: null,
    logical_cpus: logical,
    sockets: null,
    cores_per_socket: null,
    physical_cores: null,
    threads_per_core: null,
    max_ghz: null,
    cache: { l1d: null, l2: null, l3: null },
    virtualization: null,
  };
}

export function parseDmidecodeMemory(text) {
  const arrays = [];
  const devices = [];
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const h = lines.findIndex((l) => /^Handle 0x/i.test(l));
    if (h < 0) continue;
    const handle = /Handle (0x[0-9a-f]+)/i.exec(lines[h])?.[1]?.toLowerCase();
    const title = lines[h + 1];
    const kv = keyValueLines(lines.slice(h + 2));
    if (title === 'Physical Memory Array') arrays.push({ handle, kv });
    else if (title === 'Memory Device') devices.push({ handle, kv });
  }
  if (!arrays.length) return null;

  const array = arrays.find((a) => /system memory/i.test(a.kv.Use || '')) ?? arrays[0];
  const own = devices.filter((d) => !d.kv['Array Handle'] || d.kv['Array Handle'].toLowerCase() === array.handle);

  const clean = (v) => (v && !/^(unknown|not specified|none)$/i.test(v) ? v : null);
  const modules = own.map((d) => {
    const sizeStr = d.kv.Size ?? '';
    const empty = /no module installed/i.test(sizeStr);
    return {
      slot: d.kv.Locator ?? null,
      installed: !empty,
      size_bytes: empty ? null : parseSizeToBytes(sizeStr),
      type: clean(d.kv.Type),
      form_factor: clean(d.kv['Form Factor']),
      speed: clean(d.kv['Configured Memory Speed']) ?? clean(d.kv.Speed),
      manufacturer: clean(d.kv.Manufacturer),
      part_number: clean(d.kv['Part Number']),
    };
  });

  const declared = parseInt(array.kv['Number Of Devices'], 10);
  return {
    max_capacity_bytes: parseSizeToBytes(array.kv['Maximum Capacity']),
    declared_slots: Number.isFinite(declared) ? declared : null,
    modules,
  };
}

export function analyzeMemoryUpgrade(parsed) {
  const total = parsed.modules.length || parsed.declared_slots || 0;
  const used = parsed.modules.filter((m) => m.installed).length;
  const free = Math.max(total - used, 0);
  const installedBytes = parsed.modules.reduce((sum, m) => sum + (m.size_bytes ?? 0), 0);
  const unknownSize = parsed.modules.some((m) => m.installed && m.size_bytes == null);
  const max = parsed.max_capacity_bytes;
  const soldered = parsed.modules.some(
    (m) => m.installed && (/row of chips|die|chip/i.test(m.form_factor ?? '') || /onboard|soldered/i.test(m.slot ?? '')),
  );

  const consistent = max != null && !unknownSize && max >= installedBytes;
  const headroom = consistent ? max - installedBytes : null;
  const perSlot = max != null && total > 0 ? max / total : null;
  const maxNewModule = headroom != null && perSlot != null && free > 0 ? Math.min(perSlot, headroom) : null;

  return {
    total_slots: total,
    used_slots: used,
    free_slots: free,
    installed_bytes: unknownSize ? null : installedBytes,
    max_bytes: max,
    headroom_bytes: headroom,
    max_new_module_bytes: maxNewModule,
    soldered_memory_detected: soldered,
    can_add_ram: free > 0 && headroom != null && headroom > 0,
    firmware_data_inconsistent: max != null && !consistent,
  };
}


const asBool = (v) => v === true || v === 1 || v === '1';

export function parseLsblk(text) {
  const json = JSON.parse(text);
  const disks = [];
  for (const d of json.blockdevices ?? []) {
    if (d.type !== 'disk') continue; 
    if (/^(zram|ram)\d+$/.test(d.name)) continue; 
    const tran = d.tran || null;
    const rota = asBool(d.rota);
    let kind;
    if (tran === 'nvme' || /^nvme/.test(d.name)) kind = 'NVMe SSD';
    else if (tran === 'usb') kind = 'USB drive';
    else if (/^mmcblk/.test(d.name)) kind = 'eMMC/SD';
    else if (/^(vd|xvd)[a-z]+$/.test(d.name) || tran === 'virtio') kind = 'virtual disk';
    else kind = rota ? 'HDD' : 'SSD';
    disks.push({
      name: d.name,
      model: d.model ? String(d.model).trim() : null,
      size_bytes: Number(d.size),
      kind,
      interface: tran,
      removable: asBool(d.rm),
      rotational: rota,
      partitions: (d.children ?? [])
        .filter((c) => c.type === 'part')
        .map((c) => ({ name: c.name, size_bytes: Number(c.size), mountpoint: c.mountpoint ?? null })),
    });
  }
  return disks;
}

export function parseLspci(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\s+"([^"]*)"\s+"([^"]*)"\s+"([^"]*)"/.exec(line);
    if (m) out.push({ slot: m[1], class: m[2], vendor: m[3], device: m[4] });
  }
  return out;
}

export function parseNvidiaSmi(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, mem, driver] = l.split(',').map((s) => s.trim());
      return { name, vram: mem ? mem.replace(/\s*MiB$/i, ' MiB') : null, driver: driver ?? null };
    });
}


export function parseOsRelease(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=("?)(.*)\2$/.exec(line);
    if (m) out[m[1]] = m[3];
  }
  return out;
}

export function parseKernelVersion(text) {
  return /^Linux version (\S+)/.exec(text.trim())?.[1] ?? null;
}
