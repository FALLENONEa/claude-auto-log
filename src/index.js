const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { installAll, uninstallAll, printStatus } = require('./installer');

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

function printHelp() {
  console.log('Claude Auto Log');
  console.log('');
  console.log('Usage:');
  console.log('  claude-auto-log install [--time HH:MM] [--yes] [--no-scheduler]');
  console.log('  claude-auto-log uninstall');
  console.log('  claude-auto-log status');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    printHelp();
    rl.close();
    return;
  }

  if (args.command === 'status') {
    printStatus();
    rl.close();
    return;
  }

  if (args.command === 'uninstall') {
    uninstallAll();
    rl.close();
    return;
  }

  if (args.command !== 'install') {
    console.log(`Unknown command: ${args.command}`);
    printHelp();
    rl.close();
    process.exit(1);
  }

  let offTime = args.time;
  if (!offTime) {
    offTime = await question('请输入下班时间（HH:MM，例如 18:00）: ');
  }

  await installAll({ offTime, yes: args.yes, noScheduler: args.noScheduler });
  rl.close();
}

main().catch((error) => {
  console.error('[ERROR]', error.message);
  rl.close();
  process.exit(1);
});
