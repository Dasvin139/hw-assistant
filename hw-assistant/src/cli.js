import readline from 'node:readline/promises';
import { stdin, stdout, argv, env, exit } from 'node:process';
import { createAssistant } from './agent.js';
import { createOpenAICompatProvider, DEFAULT_BASE_URL, DEFAULT_MODEL } from './llm.js';

function parseArgs(args) {
  const o = { offline: false, fixtures: null, ask: null, allowRemote: env.HW_ALLOW_REMOTE === '1', baseUrl: env.HW_BASE_URL || DEFAULT_BASE_URL, model: env.HW_MODEL || DEFAULT_MODEL, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--offline') o.offline = true;
    else if (a === '--allow-remote') o.allowRemote = true;
    else if (a === '--fixtures') o.fixtures = args[++i];
    else if (a === '--ask') o.ask = args[++i];
    else if (a === '--model') o.model = args[++i];
    else if (a === '--base-url') o.baseUrl = args[++i];
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
}

const HELP = `hw-assistant — ask questions about this Linux machine's hardware

Usage: hw-assistant [options]
  --offline            Rule-based answers, no LLM (never leaves the machine)
  --ask "question"     Answer one question and exit
  --fixtures DIR       Replay saved command output instead of inspecting this machine
  --base-url URL       OpenAI-compatible endpoint (default ${DEFAULT_BASE_URL}, i.e. local Ollama)
  --model NAME         Model name (default ${DEFAULT_MODEL})
  --allow-remote       Permit a non-local endpoint (hardware data will be sent to it)

In chat: /tools  /raw  /clear  /help  /exit`;

const o = parseArgs(argv.slice(2));
if (o.help) {
  console.log(HELP);
  exit(0);
}

let provider = null;
if (!o.offline) {
  const p = createOpenAICompatProvider({ baseUrl: o.baseUrl, model: o.model, apiKey: env.HW_API_KEY || '' });
  if (!p.local && !o.allowRemote) {
    console.error(`Refusing to send hardware data to non-local endpoint ${o.baseUrl}. Re-run with --allow-remote to opt in.`);
    exit(2);
  }
  if (await p.ping()) provider = p;
  else console.error(`No LLM reachable at ${o.baseUrl}; falling back to offline mode. (Start Ollama or pass --offline to silence this.)`);
}

const assistant = await createAssistant({ fixturesDir: o.fixtures, provider });

async function answer(question) {
  try {
    const { answer: text, calls } = await assistant.ask(question);
    for (const c of calls) console.log(`  ↳ ${c.name}${c.cached ? ' (cached)' : ` (${c.ms} ms)`}${c.status === 'error' ? ' [error]' : ''}`);
    console.log(`\n${text}\n`);
  } catch (e) {
    console.log(`\nSomething went wrong: ${e.message}\n`);
  }
}

if (o.ask) {
  await answer(o.ask);
  exit(0);
}

console.log(`Hardware assistant — mode: ${assistant.mode}${o.fixtures ? ` — replaying ${o.fixtures}` : ''}`);
if (assistant.unavailable.length) console.log(`Unavailable here: ${assistant.unavailable.map((u) => `${u.name} (${u.reason})`).join('; ')}`);
console.log('Ask about CPU, RAM, storage, GPU, battery, network. Type /help for commands.\n');

const rl = readline.createInterface({ input: stdin, output: stdout, prompt: 'you> ' });
rl.prompt();
for await (const line of rl) {
  const q = line.trim();
  if (!q) {
    rl.prompt();
    continue;
  }
  if (q === '/exit' || q === '/quit') break;
  if (q === '/help') console.log(HELP);
  else if (q === '/tools') {
    for (const t of assistant.available) console.log(`  ${t.name} — ${t.description}`);
    for (const u of assistant.unavailable) console.log(`  ${u.name} — UNAVAILABLE: ${u.reason}`);
  } else if (q === '/raw') console.log(JSON.stringify(assistant.lastResults, null, 2));
  else if (q === '/clear') {
    assistant.reset();
    console.log('Conversation cleared.');
  } else await answer(q);
  rl.prompt();
}
rl.close();
