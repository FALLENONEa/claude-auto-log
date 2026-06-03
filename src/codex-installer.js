const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const packageRoot = path.resolve(__dirname, '..');
const scriptsSourceDir = path.join(packageRoot, 'plugin', 'scripts');
const codexDir = path.join(os.homedir(), '.codex');
const claudeDir = process.env.CLAUDE_AUTO_LOG_HOME || path.join(os.homedir(), '.claude');

// Decide base directory: share ~/.claude if it exists, otherwise use ~/.codex
const hasClaudeDir = fs.existsSync(claudeDir);
const baseDir = hasClaudeDir ? claudeDir : codexDir;
const hooksDir = path.join(baseDir, 'hooks');
const cclogsDir = path.join(baseDir, 'cclogs');

const hooksJsonPath = path.join(codexDir, 'hooks.json');
const configTomlPath = path.join(codexDir, 'config.toml');
const managedConfigPath = path.join(codexDir, 'managed_config.toml');
const autoLogPath = path.join(hooksDir, 'codex-auto-log.js');
const dailyReportPath = path.join(hooksDir, 'daily-report.js');
const vbsPath = path.join(hooksDir, 'daily-report-silent.vbs');
const isWin = os.platform() === 'win32';
const taskName = 'CodexDailyReport';
const launchAgentLabel = 'com.codex.auto-log.daily-report';

function ensureNode() {
  try {
    execSync('node --version', { stdio: 'pipe' });
  } catch {
    throw new Error('未检测到 Node.js，请先安装 Node.js。');
  }
}

function ensureCodexConfig() {
  if (!fs.existsSync(codexDir)) {
    fs.mkdirSync(codexDir, { recursive: true });
  }
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
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
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

// ── Script copy ──

function copyScripts() {
  fs.copyFileSync(path.join(scriptsSourceDir, 'codex-auto-log.js'), autoLogPath);
  fs.copyFileSync(path.join(scriptsSourceDir, 'daily-report.js'), dailyReportPath);
}

// ── Hook registration ──
// Write hooks inline to ~/.codex/config.toml using [[hooks.EventName]] TOML syntax.
// This is the standard user-facing approach. Non-managed hooks need /hooks trust review once.

function ensureHooks() {
  const command = `node "${autoLogPath}"`;
  const winCommand = isWin ? `"node" "${autoLogPath}"` : undefined;
  ensureConfigTomlHooks(command, winCommand);
  cleanupHooksJson(command);
  ensureHistoryPersistence();
}

function ensureConfigTomlHooks(command, winCommand) {
  // Use forward slashes — works on Windows with Node.js and avoids TOML backslash issues
  const scriptPath = autoLogPath.replace(/\\/g, '/');
  const cmd = `node "${scriptPath}"`;

  let content = '';
  if (fs.existsSync(configTomlPath)) {
    content = fs.readFileSync(configTomlPath, 'utf8');
    if (content.includes(scriptPath) || content.includes(autoLogPath)) return;
    content = stripPluginHooksToml(content);
  }

  const hooksSection = `

# ── codex-auto-log-plugin ──
[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = '${cmd}'
timeout = 10

[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = '${cmd}'
timeout = 10
`;
  fs.writeFileSync(configTomlPath, content.trimEnd() + hooksSection + '\n', 'utf8');
}

function cleanupHooksJson(command) {
  if (!fs.existsSync(hooksJsonPath)) return;
  const hooksConfig = readJson(hooksJsonPath, {});
  let changed = false;
  for (const key of ['Stop', 'UserPromptSubmit']) {
    if (!Array.isArray(hooksConfig[key]) && !Array.isArray((hooksConfig.hooks || {})[key])) continue;
    const arr = hooksConfig[key] || (hooksConfig.hooks || {})[key];
    if (!Array.isArray(arr)) continue;
    const filtered = arr
      .map(g => {
        if (!Array.isArray(g.hooks)) return g;
        return { ...g, hooks: g.hooks.filter(h => !(h && h.type === 'command' && h.command === command)) };
      })
      .filter(g => Array.isArray(g.hooks) && g.hooks.length > 0);
    if (filtered.length !== arr.length) {
      if (hooksConfig[key]) hooksConfig[key] = filtered;
      else if (hooksConfig.hooks) hooksConfig.hooks[key] = filtered;
      changed = true;
    }
  }
  if (changed) writeJson(hooksJsonPath, hooksConfig);
}

function stripPluginHooksToml(content) {
  const scriptPath = autoLogPath.replace(/\\/g, '/');
  const lines = content.split('\n');
  const meaningful = lines.filter(l => l.trim() && !l.startsWith('#'));
  const allOurs = meaningful.every(l =>
    /^\[\[hooks\.(Stop|UserPromptSubmit)(\.hooks)?\]\]/.test(l.trim()) ||
    l.includes(autoLogPath) || l.includes(scriptPath) ||
    /^(type|command|timeout|command_windows)\s*=/.test(l.trim())
  );
  if (allOurs) return '';

  const result = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^#\s*──\s*codex-auto-log-plugin/.test(line)) { i++; continue; }
    if (/^\[\[hooks\.(Stop|UserPromptSubmit)\]\]/.test(line)) {
      const groupLines = [line];
      let j = i + 1;
      while (j < lines.length) {
        if (/^\[\[hooks\.(Stop|UserPromptSubmit)\]\]/.test(lines[j])) break;
        groupLines.push(lines[j]);
        j++;
      }
      if (groupLines.some(l => l.includes(autoLogPath) || l.includes(scriptPath))) { i = j; continue; }
      result.push(...groupLines);
      i = j;
      continue;
    }
    result.push(line);
    i++;
  }
  return result.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function ensureHistoryPersistence() {
  if (!fs.existsSync(configTomlPath)) {
    fs.writeFileSync(configTomlPath, '[history]\npersistence = "save-all"\n', 'utf8');
    return;
  }

  let content = fs.readFileSync(configTomlPath, 'utf8');

  if (/\[history\]/.test(content)) {
    if (/persistence\s*=/.test(content)) {
      content = content.replace(/persistence\s*=\s*"[^"]*"/, 'persistence = "save-all"');
    } else {
      content = content.replace(/\[history\]/, '[history]\npersistence = "save-all"');
    }
  } else {
    content = content.trimEnd() + '\n\n[history]\npersistence = "save-all"\n';
  }

  fs.writeFileSync(configTomlPath, content, 'utf8');
}

function removeHooks() {
  const command = `node "${autoLogPath}"`;
  const scriptPath = autoLogPath.replace(/\\/g, '/');

  // Clean up config.toml hooks + hooks.state
  if (fs.existsSync(configTomlPath)) {
    const content = fs.readFileSync(configTomlPath, 'utf8');
    if (content.includes(autoLogPath) || content.includes(scriptPath)) {
      let cleaned = stripPluginHooksToml(content);
      cleaned = stripHookStateEntries(cleaned);
      fs.writeFileSync(configTomlPath, cleaned, 'utf8');
    }
  }

  // Clean up hooks.json (legacy)
  if (fs.existsSync(hooksJsonPath)) {
    const hooksConfig = readJson(hooksJsonPath, {});
    for (const key of ['Stop', 'UserPromptSubmit']) {
      if (!Array.isArray(hooksConfig[key])) continue;
      hooksConfig[key] = hooksConfig[key]
        .map(g => {
          if (!Array.isArray(g.hooks)) return g;
          return { ...g, hooks: g.hooks.filter(h => !(h && h.type === 'command' && h.command === command)) };
        })
        .filter(g => Array.isArray(g.hooks) && g.hooks.length > 0);
    }
    writeJson(hooksJsonPath, hooksConfig);
  }

  // Clean up managed_config.toml (if previously used)
  if (fs.existsSync(managedConfigPath)) {
    const content = fs.readFileSync(managedConfigPath, 'utf8');
    if (content.includes(autoLogPath)) {
      const cleaned = stripPluginHooksToml(content);
      const remaining = cleaned.trim();
      if (!remaining) fs.rmSync(managedConfigPath, { force: true });
      else fs.writeFileSync(managedConfigPath, cleaned, 'utf8');
    }
  }
}

function stripHookStateEntries(content) {
  const lines = content.split('\n');
  const result = [];
  let skip = false;
  for (const line of lines) {
    // Skip [hooks.state.'...'] sections that reference our plugin
    if (/^\[hooks\.state\./.test(line)) {
      skip = true;
      // Check if the next lines contain our script path
      // The state key itself may reference stop or user_prompt_submit
      if (/:(stop|user_prompt_submit):/.test(line)) {
        continue;
      }
      // Not our hook state, keep it
      skip = false;
      result.push(line);
      continue;
    }
    if (skip) {
      if (/^\[/.test(line) || /^\[\[/.test(line)) {
        skip = false;
        result.push(line);
      }
      continue;
    }
    // Also remove empty [hooks.state] header if no children remain
    if (/^\[hooks\.state\]\s*$/.test(line)) continue;
    // Remove trusted_hash lines that were for our hooks
    if (/^trusted_hash\s*=/.test(line)) continue;
    result.push(line);
  }
  let out = result.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  // Remove dangling [hooks.state] if no subsections remain
  out = out.replace(/\[hooks\.state\]\s*\n(?!\[hooks\.state\.)/g, '');
  return out;
}

// ── Platform schedulers ──

function installWindowsScheduler(triggerHour, triggerMinute) {
  const nodePath = execSync('where node', { encoding: 'utf8' }).split(/\r?\n/).find(Boolean).trim();
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${nodePath}"" ""${dailyReportPath}""", 0, False\r\n`;
  fs.writeFileSync(vbsPath, vbsContent, 'ascii');

  try { execSync(`schtasks /delete /tn "${taskName}" /f`, { stdio: 'pipe' }); } catch {}

  const hh = String(triggerHour).padStart(2, '0');
  const mm = String(triggerMinute).padStart(2, '0');
  execSync(`schtasks /create /tn "${taskName}" /tr "wscript.exe \"${vbsPath}\"" /sc daily /st ${hh}:${mm} /f`, { stdio: 'inherit' });
}

function uninstallWindowsScheduler() {
  try { execSync(`schtasks /delete /tn "${taskName}" /f`, { stdio: 'pipe' }); } catch {}
}

function installMacLaunchd(triggerHour, triggerMinute) {
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(launchAgentsDir, `${launchAgentLabel}.plist`);
  const nodePath = execSync('which node', { encoding: 'utf8' }).trim();
  const logDir = cclogsDir;

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
      <string>${dailyReportPath}</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>${triggerHour}</integer>
      <key>Minute</key>
      <integer>${triggerMinute}</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${path.join(logDir, 'daily-report.launchd.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(logDir, 'daily-report.launchd.err.log')}</string>
    <key>RunAtLoad</key>
    <false/>
  </dict>
</plist>`;

  fs.writeFileSync(plistPath, plist, 'utf8');
  try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' }); } catch {}
  execSync(`launchctl load "${plistPath}"`, { stdio: 'inherit' });
}

function uninstallMacLaunchd() {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchAgentLabel}.plist`);
  if (fs.existsSync(plistPath)) {
    try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' }); } catch {}
    fs.rmSync(plistPath, { force: true });
  }
}

function installLinuxCron(triggerHour, triggerMinute) {
  const nodePath = execSync('which node', { encoding: 'utf8' }).trim();
  const logPath = path.join(cclogsDir, 'daily-report.log');
  const cronLine = `${triggerMinute} ${triggerHour} * * * ${nodePath} "${dailyReportPath}" >> "${logPath}" 2>&1`;

  let crontab = '';
  try { crontab = execSync('crontab -l', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); } catch {}

  const lines = crontab.split('\n').filter((line) => line && !line.includes(taskName) && !line.includes('daily-report.js'));
  lines.push(`# ${taskName}`);
  lines.push(cronLine);

  execSync(`printf '%s\n' ${shellQuoteLines(lines)} | crontab -`, { shell: '/bin/bash', stdio: 'inherit' });
}

function shellQuoteLines(lines) {
  return lines.map((line) => `'${line.replace(/'/g, `'"'"'`)}'`).join(' ');
}

function uninstallLinuxCron() {
  let crontab = '';
  try { crontab = execSync('crontab -l', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); } catch {}

  const lines = crontab.split('\n').filter((line) => line && !line.includes(taskName) && !line.includes('daily-report.js'));
  if (lines.length === 0) {
    try { execSync('crontab -r', { stdio: 'pipe' }); } catch {}
    return;
  }
  execSync(`printf '%s\n' ${shellQuoteLines(lines)} | crontab -`, { shell: '/bin/bash', stdio: 'inherit' });
}

function installScheduler(triggerHour, triggerMinute) {
  if (isWin) return installWindowsScheduler(triggerHour, triggerMinute);
  if (os.platform() === 'darwin') return installMacLaunchd(triggerHour, triggerMinute);
  return installLinuxCron(triggerHour, triggerMinute);
}

function uninstallScheduler() {
  if (isWin) return uninstallWindowsScheduler();
  if (os.platform() === 'darwin') return uninstallMacLaunchd();
  return uninstallLinuxCron();
}

// ── Main install/uninstall/status ──

function printSummary(triggerHour, triggerMinute) {
  const hh = String(triggerHour).padStart(2, '0');
  const mm = String(triggerMinute).padStart(2, '0');
  console.log('');
  console.log('Codex CLI 日志插件安装完成');
  console.log(`- 脚本目录: ${hooksDir}`);
  console.log(`- Hook 配置: ${configTomlPath}`);
  console.log(`- 历史记录持久化: 已配置`);
  console.log(`- 日报触发时间: ${hh}:${mm}`);
  console.log(`- 日志目录: ${cclogsDir}`);
  console.log('');
  console.log('提示: 首次使用 Codex 时，请在 CLI 中输入 /hooks 审查并信任 hook');
}

async function installAll({ offTime, noScheduler }) {
  ensureNode();
  ensureCodexConfig();

  const { hour, minute } = validateTime(offTime);
  const trigger = subtractMinutes(hour, minute, 5);

  copyScripts();
  ensureHooks();
  if (!noScheduler) {
    installScheduler(trigger.hour, trigger.minute);
  }
  printSummary(trigger.hour, trigger.minute);
}

function uninstallAll() {
  ensureCodexConfig();
  removeHooks();
  uninstallScheduler();
  [autoLogPath, dailyReportPath, vbsPath].forEach((f) => {
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  });
  console.log('Codex CLI 日志插件卸载完成');
}

function printStatus() {
  const installed = fs.existsSync(autoLogPath);
  const command = `node "${autoLogPath}"`;

  let stopHookInstalled = false;
  let submitHookInstalled = false;

  // Check config.toml inline hooks
  if (fs.existsSync(configTomlPath)) {
    const content = fs.readFileSync(configTomlPath, 'utf8');
    if (content.includes(autoLogPath)) {
      if (content.includes('[[hooks.Stop]]')) stopHookInstalled = true;
      if (content.includes('[[hooks.UserPromptSubmit]]')) submitHookInstalled = true;
    }
  }

  let historyEnabled = false;
  if (fs.existsSync(configTomlPath)) {
    const content = fs.readFileSync(configTomlPath, 'utf8');
    historyEnabled = /\[history\]/.test(content) && /persistence\s*=\s*"save-all"/.test(content);
  }

  console.log(`Codex CLI 日志插件状态:`);
  console.log(`  脚本: ${installed ? '已安装' : '未安装'}`);
  console.log(`  Stop Hook: ${stopHookInstalled ? '已配置' : '未配置'}`);
  console.log(`  UserPromptSubmit Hook: ${submitHookInstalled ? '已配置' : '未配置'}`);
  console.log(`  历史持久化: ${historyEnabled ? '已启用' : '未启用'}`);
  console.log(`  平台: ${os.platform()}`);
}

module.exports = { installAll, uninstallAll, printStatus };
