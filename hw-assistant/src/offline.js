export const TOPIC_TOOL = {
  overview: 'get_system_overview',
  cpu: 'get_cpu_info',
  memory: 'get_memory_info',
  storage: 'get_storage_info',
  gpu: 'get_gpu_info',
  battery: 'get_battery_info',
  network: 'get_network_hardware',
};

const PATTERNS = [
  ['memory', /\b(ram|memory|dimms?|so-?dimm|slots?|ddr\d?)\b/i],
  ['cpu', /\b(cpu|processor|cores?|threads?|clock speed|ghz)\b/i],
  ['storage', /\b(ssd|nvme|hdd|disks?|drives?|storage|sata|partitions?)\b/i],
  ['gpu', /\b(gpu|graphics|video card|vga|nvidia|radeon|vram)\b/i],
  ['battery', /\b(battery|charge|charging|cycles?)\b/i],
  ['network', /\b(wi-?fi|wireless|ethernet|network (card|adapter)|nic|lan)\b/i],
];
const OVERVIEW = /\b(os|distro|distribution|kernel|ubuntu|model|manufacturer|vendor|bios|laptop|machine|computer)\b/i;
const EVERYTHING = /\b(everything|all (the )?(specs|hardware)|full (spec|summary|report)|specs?|overview|summary)\b/i;
const UPGRADE = /\b(add|upgrade|more|expand|expansion|increase|max(imum)?|free|empty|spare|room|slots?|replace)\b/i;
const FOLLOW_UP = /^\s*(and|also|what about|how about|then)\b/i;

export const SCOPE_MESSAGE =
  "I can only answer questions about this machine's hardware: CPU, RAM (including upgrade options), storage, GPU, battery, network adapters, and OS/vendor details. I don't have data to answer that.";

export function route(question, lastTopics = []) {
  if (EVERYTHING.test(question)) return { topics: Object.keys(TOPIC_TOOL), intent: 'all' };
  const topics = PATTERNS.filter(([, re]) => re.test(question)).map(([t]) => t);
  if (!topics.length && OVERVIEW.test(question)) topics.push('overview');
  if (!topics.length && FOLLOW_UP.test(question) && lastTopics.length) return { topics: lastTopics, intent: 'follow-up' };
  let intent = 'info';
  if (topics.includes('memory') && UPGRADE.test(question)) intent = 'upgrade';
  if (topics.includes('storage') && /nvme/i.test(question)) intent = 'nvme';
  return { topics, intent };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
const sentences = (list) => list.map(sentence).join(' ');
const TOPIC_LABEL = { overview: 'system overview', cpu: 'CPU', memory: 'RAM', storage: 'storage', gpu: 'GPU', battery: 'battery', network: 'network adapter' };

function unavailable(topic, r) {
  const reason = r?.error ?? r?.reason ?? 'the required data source is not available';
  return `I couldn't determine your ${TOPIC_LABEL[topic] ?? topic} details: ${reason.replace(/[.\s]+$/, '')}.`;
}

function memory(intent, r) {
  const d = r.data;
  if (!d.slot_data_available) {
    return `Your system reports ${d.usable_total} of usable RAM (${d.available_now} available right now). I can't determine the physical slots or the board's maximum capacity, so I can't say whether or how much you can upgrade. ${sentences(r.caveats)}`.trim();
  }
  const spec = [d.memory_type, d.form_factor].filter(Boolean).join(' ');
  const slots = `${d.used_slots} of ${plural(d.total_slots, 'slot')}`;
  if (intent !== 'upgrade') {
    return `You have ${d.installed_total} of RAM installed in ${slots}${spec ? ` (${spec}${d.speed ? ` at ${d.speed}` : ''})` : ''}. The OS can use ${d.usable_total}, and ${d.available_now} is available right now.`;
  }
  const u = d.upgrade;
  const parts = [`You have ${d.installed_total} in ${slots}${spec ? ` (${spec})` : ''}.`];
  if (!d.max_supported) {
    parts.push("The firmware doesn't report a maximum supported capacity, so I can't say how much you could add.");
  } else if (u.can_add_ram) {
    const add = u.free_slots === 1
      ? `a stick of up to ${u.max_new_module}`
      : `up to ${u.free_slots} sticks of up to ${u.max_new_module} each`;
    parts.push(`The board reports support for up to ${d.max_supported}, so you can add ${add} (${u.max_additional_total} of headroom in total).`);
  } else if (u.free_slots === 0) {
    parts.push(`All slots are in use, so adding RAM means replacing existing modules (the board reports a ${d.max_supported} maximum).`);
  } else {
    parts.push(`The board reports a ${d.max_supported} maximum, which you've already reached or the data is inconsistent, so I can't recommend adding more.`);
  }
  if (u.soldered_memory_detected) parts.push('Some of the memory appears to be soldered to the board and cannot be replaced.');
  parts.push(`Note: ${u.note}`);
  return parts.join(' ');
}

function cpu(r) {
  const d = r.data;
  const bits = [];
  if (d.physical_cores && d.logical_cpus) bits.push(`${plural(d.physical_cores, 'core')} / ${plural(d.logical_cpus, 'thread')}`);
  else if (d.logical_cpus) bits.push(plural(d.logical_cpus, 'logical CPU', 'logical CPUs'));
  if (d.max_ghz) bits.push(`up to ${d.max_ghz} GHz`);
  const cache = [d.cache?.l2 && `L2 ${d.cache.l2}`, d.cache?.l3 && `L3 ${d.cache.l3}`].filter(Boolean).join(', ');
  if (cache) bits.push(cache);
  return `Your CPU is the ${d.model ?? 'processor I could not identify'}${bits.length ? `: ${bits.join(', ')}` : ''}.${r.caveats.length ? ` ${sentences(r.caveats)}` : ''}`;
}

function storage(intent, r) {
  const disks = r.data.disks;
  if (!disks.length) return 'I did not find any physical disks.';
  if (intent === 'nvme') {
    const nvme = disks.filter((d) => d.type === 'NVMe SSD');
    const other = disks.filter((d) => d.type !== 'NVMe SSD');
    if (nvme.length) {
      const list = nvme.map((d) => `${d.name} (${d.size}${d.model ? `, ${d.model}` : ''})`).join(', ');
      return `Yes. ${list} ${nvme.length === 1 ? 'is' : 'are'} NVMe.${other.length ? ` Your other drive${other.length === 1 ? '' : 's'}: ${other.map((d) => `${d.name} is ${d.type}${d.interface ? ` over ${d.interface.toUpperCase()}` : ''}`).join('; ')}.` : ''}`;
    }
    return `No. I don't see an NVMe drive. ${disks.map((d) => `${d.name} is ${d.type}${d.interface ? ` (${d.interface.toUpperCase()})` : ''}`).join('; ')}.`;
  }
  const lines = disks.map((d) => `${d.name}: ${d.size} ${d.type}${d.model ? ` (${d.model})` : ''}${d.partitions.length ? `, mounted: ${d.partitions.filter((p) => p.mountpoint).map((p) => p.mountpoint).join(', ') || 'none'}` : ''}`);
  return `You have ${plural(disks.length, 'disk')}:\n  - ${lines.join('\n  - ')}`;
}

function gpu(r) {
  const { adapters, nvidia_details: smi } = r.data;
  const lines = adapters.map((a) => `${a.vendor} ${a.name} (${a.kind})`);
  let s = `Graphics: ${lines.join('; ')}.`;
  if (smi.length) s += ` NVIDIA details: ${smi.map((g) => `${g.name}, ${g.vram ?? 'VRAM unknown'}, driver ${g.driver ?? 'unknown'}`).join('; ')}.`;
  if (r.caveats.length) s += ` ${sentences(r.caveats)}`;
  return s;
}

function battery(r) {
  const d = r.data;
  if (!d.present) return 'No battery was detected (this may be a desktop or a virtual machine).';
  return d.batteries
    .map((b) => {
      const parts = [`${b.name}: ${b.charge_percent ?? '?'}% (${b.status ?? 'status unknown'})`];
      if (b.health_percent != null) parts.push(`health about ${b.health_percent}% of design capacity`);
      if (b.cycle_count != null) parts.push(`${b.cycle_count} charge cycles`);
      return parts.join(', ');
    })
    .join('; ') + '.';
}

function network(r) {
  const a = r.data.adapters;
  if (!a.length) return `I found no PCI network adapters. ${sentences(r.caveats)}`.trim();
  return `Network hardware: ${a.map((x) => `${x.type}: ${x.vendor} ${x.name}`).join('; ')}.`;
}

function overview(r) {
  const d = r.data;
  const machine = [d.vendor, d.model_version ?? d.model].filter(Boolean).join(' ') || 'an unidentified machine';
  const parts = [`This is ${machine}`];
  if (d.os) parts.push(`running ${d.os}`);
  if (d.kernel) parts.push(`(kernel ${d.kernel})`);
  let s = parts.join(' ') + '.';
  if (d.bios) s += ` BIOS ${d.bios.version}${d.bios.date ? ` (${d.bios.date})` : ''}.`;
  return s;
}

export function render(intent, topics, results) {
  const out = [];
  for (const topic of topics) {
    const r = results[topic];
    if (!r || r.status !== 'ok') {
      out.push(unavailable(topic, r));
      continue;
    }
    if (topic === 'memory') out.push(memory(intent, r));
    else if (topic === 'cpu') out.push(cpu(r));
    else if (topic === 'storage') out.push(storage(intent, r));
    else if (topic === 'gpu') out.push(gpu(r));
    else if (topic === 'battery') out.push(battery(r));
    else if (topic === 'network') out.push(network(r));
    else if (topic === 'overview') out.push(overview(r));
  }
  return out.join('\n');
}
