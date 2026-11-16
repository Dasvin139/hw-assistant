# hw-assistant: a hardware Q&A chatbot for your Linux laptop

Ask plain-English questions about the machine you're on ("How much RAM do I have?", "Is my SSD NVMe?", "Can I add more RAM, and how much?") and get answers computed from real system data, not from a model's memory.

**Zero dependencies, Node.js 20+.** Works with a local LLM (Ollama) or fully offline with a deterministic rule-based engine.

```bash
npm run demo                       # replays a saved laptop; no LLM, no root needed
node src/cli.js --offline          # inspect THIS machine, no LLM
node src/cli.js                    # inspect THIS machine with a local LLM (Ollama, qwen2.5:7b)
node src/cli.js --ask "Is my SSD NVMe?"
npm test                           # 13 tests
```

Example (`npm run demo`):

```
you> Can I add more RAM, and how much?
  ↳ get_memory_info (4 ms)
You have 16 GB in 1 of 2 slots (DDR4 SODIMM). The board reports support for up to 64 GB,
so you can add a stick of up to 32 GB (48 GB of headroom in total). Note: ...confirm it in
the manufacturer's spec sheet. ...
you> and what about the GPU?
  ↳ get_gpu_info (3 ms)
Graphics: Intel ... Iris Xe ...; NVIDIA ... GeForce RTX 3050 Mobile ... nvidia-smi is not
installed, so VRAM size and driver version for the NVIDIA GPU are unknown.
```

## Architecture

```
question ─► Router (LLM tool-calling, or keyword router offline)
              │ picks a NAMED tool + validated args
              ▼
         Tool registry ──► validateArgs ──► System layer (the only code that touches the OS)
                                             │  allow-listed command table → execFile, no shell
                                             │  allow-listed /proc /sys /etc paths (read-only)
                                             ▼
                                    Parsers → typed objects → pre-formatted units
                                             ▼
         Envelope (sanitised JSON, caveats) ──► LLM writes answer from it  /  templates (offline)
```

| File | Role |
|---|---|
| `src/system.js` | Command and file allow-lists, `execFile` wrapper, privilege handling, fixture replay |
| `src/parsers.js` | `lscpu`, `lsblk -J`, `lspci -mm`, `dmidecode -t memory`, `/proc/meminfo`, battery; RAM upgrade maths |
| `src/tools.js` | 7 tools, JSON-schema validation, capability discovery, result envelope |
| `src/agent.js` | Tool-calling loop, session cache, conversation history, system prompt |
| `src/offline.js` | Keyword router and deterministic answer templates |
| `src/llm.js` | OpenAI-compatible client (Ollama, llama.cpp, vLLM, hosted) |

## The design questions

### Safety: commands are read-only and allow-listed
- The model never writes a command. It picks a **tool name** from a fixed registry; arguments are validated against a JSON schema (unknown or mistyped args are rejected). Today **no tool accepts a free-form string at all**, so there is nothing to inject into.
- `system.js` maps command ids to fixed argv arrays and runs them with `execFile` (absolute binary path, `shell: false`, 5 s timeout, 2 MB output cap, minimal env). `dmidecode; rm -rf /` can't be expressed.
- File reads are limited to anchored regexes over a few `/proc`, `/sys`, `/etc` paths. Serial numbers (`product_serial`, DIMM serials) are never read or kept.
- Tests assert that unknown tools, extra args and non-allow-listed paths are rejected **without executing anything**.

### Permissions: `dmidecode` needs root
The agent never runs as root. `dmidecode -t memory` is the one privileged command; it runs as `sudo -n <abs path> -t memory`:
- `sudo -n` never prompts, so it can't hang the chat.
- `scripts/install-sudoers.sh` installs a rule permitting exactly that binary with exactly those arguments, validated with `visudo -cf`.
- **If it isn't configured, the assistant degrades instead of failing:** it still reports usable RAM from `/proc/meminfo`, says slot data is unavailable and why, and refuses to guess an upgrade path.
- Alternatives I considered: a tiny root helper daemon on a Unix socket (stronger isolation, more to install) and non-root-only mode (zero setup, loses DMI data).

### Accuracy: no hallucinated specs
- **Facts come from code, not the model.** Units are pre-formatted ("16 GB") and RAM-upgrade maths (free slots, headroom, max stick size) is computed in `analyzeMemoryUpgrade`, so the LLM does no arithmetic.
- The system prompt requires answers only from tool JSON, and "I can't determine this" when data or a tool is missing. Missing fields are `null`, never defaults.
- Unreliable data is flagged: firmware max capacity is often wrong on laptops, so every upgrade answer carries that caveat; inconsistent firmware data (max < installed) disables the "can add" claim; soldered memory is detected from form factor/locator; VRAM is reported as unknown when `nvidia-smi` is absent.
- `dmidecode` is parsed per section with exact keys. (A naive `Size:` regex over the whole output also matches `Cache Size`, `Volatile Size`, `Logical Size` and corrupts slot counts; a test covers this.)
- **Offline mode cannot hallucinate at all**: every number in an answer is read from a tool result.

### Portability
- Startup **capability discovery** checks which tools can work here. Unavailable tools aren't offered to the model, and the prompt lists them so it won't pretend to know that data.
- Fallbacks: `lscpu` → `/proc/cpuinfo`; `dmidecode` → `/proc/meminfo`. `lsblk` JSON flags differ between util-linux versions (`"0"` vs `false`); the parser normalises both. Loop devices and zram are skipped; virtio disks are labelled "virtual disk" rather than guessed as HDD/SSD.
- `--fixtures DIR` replays saved command output, so parsers are tested against real-shaped data from different machines (`fixtures/laptop-1` full hardware; `fixtures/laptop-2` no `lsblk`/`lspci`, `dmidecode` denied).

### Follow-ups
Session memory has two parts: a **tool-result cache** (static data cached for the session, volatile data like free memory for 15 s) and the **conversation history** (last 6 turns, including tool messages, in LLM mode). "And what about the GPU?" resolves through the LLM using the history; offline, a follow-up opener ("and…", "what about…") with no topic reuses the previous topic.

### Privacy
Everything runs locally. The default LLM endpoint is a **local Ollama** (`qwen2.5:7b`), and a **non-loopback endpoint is refused** unless you pass `--allow-remote`, so hardware data can't leave the machine by accident. `--offline` uses no model at all. MAC/IP addresses and serial numbers are never collected.

### Prompt injection via hardware strings
Disk models, volume labels and mount points are attacker-influenced (a USB stick can be labelled "ignore previous instructions"). Tool output is therefore control-character-stripped and length-capped, wrapped in a JSON envelope marked as untrusted data, and the prompt says it is never an instruction. The model has no dangerous tool to be tricked into calling, which is the stronger defence.

## Tools
`get_system_overview`, `get_cpu_info`, `get_memory_info`, `get_storage_info`, `get_gpu_info`, `get_battery_info`, `get_network_hardware`.

## Limitations and next steps
- The LLM path is covered by tests with a scripted model, but I haven't run it against a live Ollama model here; small models can mis-select tools, so the offline router is the reliable fallback.
- Per-stick maximum is estimated as max capacity ÷ slots; real limits also depend on the CPU memory controller and module density. The answer says so.
- Offline routing is keyword-based; the LLM handles paraphrases and compound questions better.
- Possible additions: post-hoc grounding check (every number in the answer must appear in tool output), displays/USB/sensors tools, a Unix-socket root helper for enterprise use.
