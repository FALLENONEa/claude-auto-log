const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execSync } = require('child_process');
const { installAll, uninstallAll, printStatus } = require('./installer');
const codexInstaller = require('./codex-installer');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function question(prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function parseArgs(argv) {
  const [command = 'install', ...rest] = argv;
  const args = { command, yes: false, time: '', noScheduler: false };

  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (value === '--yes' || value === '-y') {
      args.yes = true;
    } else if (value === '--time' && rest[i + 1]) {
      args.time = rest[i + 1];
      i += 1;
    } else if (value === '--no-scheduler') {
      args.noScheduler = true;
    }
  }

  return args;
}

function detectCLIs() {
  const hasClaude = checkCommand('claude');
  const hasCodex = checkCommand('codex');
  return { hasClaude, hasCodex };
}

function checkCommand(name) {
  try {
    execSync(`${os.platform() === 'win32' ? 'where' : 'which'} ${name}`, { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function printHelp() {
  console.log('Claude Auto Log');
  console.log('');
  console.log('Usage:');
  console.log('  claude-auto-log install [--time HH:MM] [--yes] [--no-scheduler]');
  console.log('  claude-auto-log uninstall');
  console.log('  claude-auto-log status');
  console.log('');
  console.log('Commands:');
  console.log('  install     Auto-detect installed CLIs and configure hooks');
  console.log('  uninstall   Remove all hooks');
  console.log('  status      Show installation status');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    printHelp();
    rl.close();
    return;
  }

  if (args.command === 'status') {
    const { hasClaude, hasCodex } = detectCLIs();
    console.log(`检测到: Claude CLI ${hasClaude ? '✓' : '✗'} | Codex CLI ${hasCodex ? '✓' : '✗'}`);
    console.log('');
    if (hasClaude) printStatus();
    if (hasCodex) codexInstaller.printStatus();
    if (!hasClaude && !hasCodex) console.log('未检测到 Claude CLI 或 Codex CLI');
    rl.close();
    return;
  }

  if (args.command === 'uninstall') {
    uninstallAll();
    codexInstaller.uninstallAll();
    rl.close();
    return;
  }

  if (args.command !== 'install') {
    console.log(`Unknown command: ${args.command}`);
    printHelp();
    rl.close();
    process.exit(1);
  }

  // ── Auto-detect and install ──
  const { hasClaude, hasCodex } = detectCLIs();

  if (!hasClaude && !hasCodex) {
    console.log('未检测到 Claude CLI 或 Codex CLI，请先安装其中一个。');
    rl.close();
    process.exit(1);
  }

  let offTime = args.time;
  if (!offTime) {
    offTime = await question('请输入下班时间（HH:MM，例如 18:00）: ');
  }

  if (hasClaude) {
    console.log('\n── 配置 Claude Code ──');
    await installAll({ offTime, yes: args.yes, noScheduler: args.noScheduler });
  }

  if (hasCodex) {
    console.log('\n── 配置 Codex CLI ──');
    await codexInstaller.installAll({ offTime, noScheduler: args.noScheduler });
  }

  rl.close();
}

main().catch((error) => {
  console.error('[ERROR]', error.message);
  rl.close();
  process.exit(1);
});
