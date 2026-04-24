const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const packageRoot = path.resolve(__dirname, '..');
const pluginSourceDir = path.join(packageRoot, 'plugin');
const claudeDir = process.env.CLAUDE_AUTO_LOG_HOME || path.join(os.homedir(), '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');
const vendorDir = path.join(claudeDir, 'vendor');
const pluginInstallDir = path.join(vendorDir, 'claude-auto-log');
const isWin = os.platform() === 'win32';
const taskName = 'ClaudeDailyReport';
const launchAgentLabel = 'com.claude.auto-log.daily-report';

function ensureNode() {
  try {
    execSync('node --version', { stdio: 'pipe' });
  } catch {
    throw new Error('未检测到 Node.js，请先安装 Node.js。');
  }
}

function ensureClaudeSettings() {
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, '{}\n', 'utf8');
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function copyDir(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function validateTime(offTime) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(offTime || '');
  if (!match) {
    throw new Error('时间格式错误，请使用 HH:MM，例如 18:00。');
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('时间超出范围，请使用 00:00 到 23:59。');
  }

  return { hour, minute };
}

function subtractMinutes(hour, minute, delta) {
  let total = hour * 60 + minute - delta;
  while (total < 0) total += 24 * 60;
  return {
    hour: Math.floor(total / 60),
    minute: total % 60,
  };
}

function ensurePluginFiles() {
  fs.mkdirSync(vendorDir, { recursive: true });
  if (fs.existsSync(pluginInstallDir)) {
    fs.rmSync(pluginInstallDir, { recursive: true, force: true });
  }
  copyDir(pluginSourceDir, pluginInstallDir);
}

function registerMarketplace() {
  const marketplacePath = path.join(pluginInstallDir, 'marketplace.json');
  try {
    execSync(`claude plugin marketplace add "${marketplacePath}"`, { stdio: 'pipe' });
  } catch {}
}

function ensureStopHook() {
  const settings = readJson(settingsPath, {});
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  if (!Array.isArray(settings.hooks.Stop)) {
    settings.hooks.Stop = [];
  }

  const command = `node "${path.join(pluginInstallDir, 'scripts', 'auto-log.js')}"`;
  const stopEntries = settings.hooks.Stop;

  const alreadyExists = stopEntries.some((group) => Array.isArray(group.hooks) && group.hooks.some((hook) => hook && hook.type === 'command' && hook.command === command));

  if (!alreadyExists) {
    stopEntries.push({
      matcher: '',
      hooks: [
        {
          type: 'command',
          command,
        },
      ],
    });
  }

  writeJson(settingsPath, settings);
}

function removeStopHook() {
  const settings = readJson(settingsPath, {});
  const command = `node "${path.join(pluginInstallDir, 'scripts', 'auto-log.js')}"`;

  if (!settings.hooks || !Array.isArray(settings.hooks.Stop)) {
    writeJson(settingsPath, settings);
    return;
  }

  settings.hooks.Stop = settings.hooks.Stop
    .map((group) => {
      if (!Array.isArray(group.hooks)) return group;
      return {
        ...group,
        hooks: group.hooks.filter((hook) => !(hook && hook.type === 'command' && hook.command === command)),
      };
    })
    .filter((group) => Array.isArray(group.hooks) && group.hooks.length > 0);

  writeJson(settingsPath, settings);
}

function installWindowsScheduler(triggerHour, triggerMinute) {
  const vbsPath = path.join(pluginInstallDir, 'scripts', 'daily-report-silent.vbs');
  const scriptPath = path.join(pluginInstallDir, 'scripts', 'daily-report.js');
  const nodePath = execSync('where node', { encoding: 'utf8' }).split(/\r?\n/).find(Boolean).trim();
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${nodePath}"" ""${scriptPath}""", 0, False\r\n`;
  fs.writeFileSync(vbsPath, vbsContent, 'ascii');

  try {
    execSync(`schtasks /delete /tn "${taskName}" /f`, { stdio: 'pipe' });
  } catch {}

  const hh = String(triggerHour).padStart(2, '0');
  const mm = String(triggerMinute).padStart(2, '0');
  execSync(`schtasks /create /tn "${taskName}" /tr "wscript.exe \"${vbsPath}\"" /sc daily /st ${hh}:${mm} /f`, { stdio: 'inherit' });
}

function uninstallWindowsScheduler() {
  try {
    execSync(`schtasks /delete /tn "${taskName}" /f`, { stdio: 'pipe' });
  } catch {}
}

function installMacLaunchd(triggerHour, triggerMinute) {
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(launchAgentsDir, `${launchAgentLabel}.plist`);
  const nodePath = execSync('which node', { encoding: 'utf8' }).trim();
  const scriptPath = path.join(pluginInstallDir, 'scripts', 'daily-report.js');
  const logDir = path.join(claudeDir, 'cclogs');

  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${launchAgentLabel}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${nodePath}</string>
      <string>${scriptPath}</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>${triggerHour}</integer>
      <key>Minute</key>
      <integer>${triggerMinute}</integer>
    </dict>
    <key>WorkingDirectory</key>
    <string>${pluginInstallDir}</string>
    <key>StandardOutPath</key>
    <string>${path.join(logDir, 'daily-report.launchd.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(logDir, 'daily-report.launchd.err.log')}</string>
    <key>RunAtLoad</key>
    <false/>
  </dict>
</plist>
`;

  fs.writeFileSync(plistPath, plist, 'utf8');

  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
  } catch {}
  execSync(`launchctl load "${plistPath}"`, { stdio: 'inherit' });
}

function uninstallMacLaunchd() {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchAgentLabel}.plist`);
  if (fs.existsSync(plistPath)) {
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
    } catch {}
    fs.rmSync(plistPath, { force: true });
  }
}

function installLinuxCron(triggerHour, triggerMinute) {
  const nodePath = execSync('which node', { encoding: 'utf8' }).trim();
  const scriptPath = path.join(pluginInstallDir, 'scripts', 'daily-report.js');
  const logPath = path.join(claudeDir, 'cclogs', 'daily-report.log');
  const cronLine = `${triggerMinute} ${triggerHour} * * * ${nodePath} "${scriptPath}" >> "${logPath}" 2>&1`;

  let crontab = '';
  try {
    crontab = execSync('crontab -l', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {}

  const lines = crontab
    .split('\n')
    .filter((line) => line && !line.includes(taskName) && !line.includes('claude-auto-log') && !line.includes('daily-report.js'));
  lines.push(`# ${taskName}`);
  lines.push(cronLine);

  execSync(`printf '%s\n' ${shellQuoteLines(lines)} | crontab -`, { shell: '/bin/bash', stdio: 'inherit' });
}

function shellQuoteLines(lines) {
  return lines.map((line) => `'${line.replace(/'/g, `'"'"'`)}'`).join(' ');
}

function uninstallLinuxCron() {
  let crontab = '';
  try {
    crontab = execSync('crontab -l', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {}

  const lines = crontab
    .split('\n')
    .filter((line) => line && !line.includes(taskName) && !line.includes('claude-auto-log') && !line.includes('daily-report.js'));

  if (lines.length === 0) {
    try {
      execSync('crontab -r', { stdio: 'pipe' });
    } catch {}
    return;
  }

  execSync(`printf '%s\n' ${shellQuoteLines(lines)} | crontab -`, { shell: '/bin/bash', stdio: 'inherit' });
}

function installScheduler(triggerHour, triggerMinute) {
  if (isWin) {
    installWindowsScheduler(triggerHour, triggerMinute);
    return;
  }

  if (os.platform() === 'darwin') {
    installMacLaunchd(triggerHour, triggerMinute);
    return;
  }

  installLinuxCron(triggerHour, triggerMinute);
}

function uninstallScheduler() {
  if (isWin) {
    uninstallWindowsScheduler();
    return;
  }

  if (os.platform() === 'darwin') {
    uninstallMacLaunchd();
    return;
  }

  uninstallLinuxCron();
}

function printSummary(triggerHour, triggerMinute) {
  const hh = String(triggerHour).padStart(2, '0');
  const mm = String(triggerMinute).padStart(2, '0');
  console.log('');
  console.log('安装完成');
  console.log(`- 插件目录: ${pluginInstallDir}`);
  console.log(`- Stop Hook: 已写入 ${settingsPath}`);
  console.log(`- 日报触发时间: ${hh}:${mm}`);
  console.log(`- 日志目录: ${path.join(claudeDir, 'cclogs')}`);
}

async function installAll({ offTime, noScheduler }) {
  ensureNode();
  ensureClaudeSettings();

  const { hour, minute } = validateTime(offTime);
  const trigger = subtractMinutes(hour, minute, 5);

  ensurePluginFiles();
  registerMarketplace();
  ensureStopHook();
  if (!noScheduler) {
    installScheduler(trigger.hour, trigger.minute);
  }
  printSummary(trigger.hour, trigger.minute);
}

function uninstallAll() {
  ensureClaudeSettings();
  removeStopHook();
  uninstallScheduler();
  if (fs.existsSync(pluginInstallDir)) {
    fs.rmSync(pluginInstallDir, { recursive: true, force: true });
  }
  console.log('卸载完成');
}

function printStatus() {
  const installed = fs.existsSync(pluginInstallDir);
  const settings = readJson(settingsPath, {});
  const command = `node "${path.join(pluginInstallDir, 'scripts', 'auto-log.js')}"`;
  const hookInstalled = !!(settings.hooks && Array.isArray(settings.hooks.Stop) && settings.hooks.Stop.some((group) => Array.isArray(group.hooks) && group.hooks.some((hook) => hook && hook.command === command)));

  console.log(`插件目录: ${installed ? '已安装' : '未安装'}`);
  console.log(`Stop Hook: ${hookInstalled ? '已配置' : '未配置'}`);
  console.log(`平台: ${os.platform()}`);
}

module.exports = {
  installAll,
  uninstallAll,
  printStatus,
};
