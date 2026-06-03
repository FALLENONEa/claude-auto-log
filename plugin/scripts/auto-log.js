const fs = require('fs');
const path = require('path');
const os = require('os');

function isEnabled() {
  const claudeDir = process.env.CLAUDE_AUTO_LOG_HOME || path.join(os.homedir(), '.claude');
  return fs.existsSync(path.join(claudeDir, 'cclogs', '.enabled'));
}

let chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  try {
    if (!isEnabled()) process.exit(0);

    const payload = JSON.parse(Buffer.concat(chunks).toString());
    const hookEvent = payload.hook_event_name || 'Stop';
    const sessionId = payload.session_id;
    const cwd = payload.cwd;
    if (!sessionId || !cwd) process.exit(0);

    const claudeDir = process.env.CLAUDE_AUTO_LOG_HOME || path.join(os.homedir(), '.claude');
    const sessionFile = findSessionFile(path.join(claudeDir, 'projects'), sessionId);
    if (!sessionFile) process.exit(0);

    const messages = parseSessionFile(sessionFile);
    if (messages.length < 2) process.exit(0);

    const turn = hookEvent === 'UserPromptSubmit'
      ? findMissedInterrupt(messages)
      : findCurrentTurn(messages);
    if (!turn) process.exit(0);

    const userText = extractText(turn.user.message);
    const assistantText = extractText(turn.assistant.message);
    if (!userText && !assistantText) process.exit(0);

    const codeChanges = extractCodeChangesRange(messages, turn.userIdx, turn.assistantIdx);
    const tokenUsage = extractTokenUsage(messages, turn.userIdx, turn.assistantIdx);
    const projectCwd = findProjectCwd(messages) || cwd;
    const projectName = path.basename(projectCwd.replace(/\\/g, '/'));
    const cclogsBase = getCclogsBase(claudeDir);
    const logDir = path.join(cclogsBase, new Date().toISOString().slice(0, 10));
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${projectName}.md`);

    if (isAlreadyLogged(logFile, userText)) process.exit(0);

    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 8);
    let entry = `## [对话记录] ${timeStr}${turn.interrupted ? ' · [中断]' : ''}`;
    const duration = Math.round((new Date(turn.assistant.timestamp) - new Date(turn.user.timestamp)) / 1000);
    if (duration >= 0) {
      const min = Math.floor(duration / 60);
      const sec = duration % 60;
      entry += ` | 耗时: ${min > 0 ? min + 'm' : ''}${sec}s`;
    }
    if (tokenUsage.total > 0) {
      entry += ` | 输入Token: ${fmtToken(tokenUsage.input)} | 输出Token: ${fmtToken(tokenUsage.output)} | 总计Token: ${fmtToken(tokenUsage.total)}`;
      entry += `\n<!-- token_stats input=${tokenUsage.input} output=${tokenUsage.output} total=${tokenUsage.total} -->`;
    }
    entry += `\n\n### 用户问题\n${userText}\n\n### Claude回答\n${assistantText}`;
    if (codeChanges.length > 0) entry += `\n\n### 代码变更\n${codeChanges.join('\n')}`;
    entry += `\n\n---\n\n`;

    fs.appendFileSync(logFile, entry, 'utf-8');
  } catch {}
});

// ── Turn finders ──

function findCurrentTurn(messages) {
  let assistant = null, assistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'assistant') {
      assistant = messages[i]; assistantIdx = i; break;
    }
  }
  if (!assistant) return null;

  let interrupted = false;
  for (let i = assistantIdx + 1; i < messages.length; i++) {
    if (messages[i].type === 'user' && !messages[i].toolUseResult) {
      if (extractText(messages[i].message).includes('Request interrupted by user')) {
        interrupted = true; break;
      }
    }
  }

  let user = null, userIdx = -1;
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (messages[i].type === 'user' && messages[i].promptId && !messages[i].toolUseResult) {
      const text = extractText(messages[i].message);
      if (text.includes('Request interrupted by user')) { interrupted = true; continue; }
      if (isSystemMessage(text)) continue;
      user = messages[i]; userIdx = i; break;
    }
  }

  return user ? { user, assistant, userIdx, assistantIdx, interrupted } : null;
}

function findMissedInterrupt(messages) {
  let currentPromptIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'user' && messages[i].promptId && !messages[i].toolUseResult) {
      const text = extractText(messages[i].message);
      if (text.includes('Request interrupted by user')) continue;
      if (isSystemMessage(text)) continue;
      currentPromptIdx = i; break;
    }
  }
  if (currentPromptIdx < 1) return null;

  let assistantIdx = -1;
  for (let i = currentPromptIdx - 1; i >= 0; i--) {
    if (messages[i].type === 'assistant') { assistantIdx = i; break; }
  }
  if (assistantIdx < 0) return null;

  let interrupted = false;
  for (let i = assistantIdx + 1; i < currentPromptIdx; i++) {
    if (messages[i].type === 'user' && !messages[i].toolUseResult) {
      if (extractText(messages[i].message).includes('Request interrupted by user')) {
        interrupted = true; break;
      }
    }
  }
  if (!interrupted) return null;

  let user = null, userIdx = -1;
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (messages[i].type === 'user' && messages[i].promptId && !messages[i].toolUseResult) {
      const text = extractText(messages[i].message);
      if (text.includes('Request interrupted by user')) continue;
      if (isSystemMessage(text)) continue;
      user = messages[i]; userIdx = i; break;
    }
  }

  return user ? { user, assistant: messages[assistantIdx], userIdx, assistantIdx, interrupted: true } : null;
}

// ── Helpers ──

function findSessionFile(projectsDir, sessionId) {
  const filename = sessionId + '.jsonl';
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const fullPath = path.join(projectsDir, dir, filename);
      if (fs.existsSync(fullPath)) return fullPath;
    }
  } catch {}
  return null;
}

function parseSessionFile(sessionFile) {
  return fs.readFileSync(sessionFile, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(m => m && (m.type === 'user' || m.type === 'assistant'));
}

function extractText(message) {
  if (!message || !message.content) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n');
  }
  return '';
}

function extractCodeChangesRange(messages, startIdx, endIdx) {
  const changes = [];
  let recentText = '';
  for (let i = startIdx; i <= endIdx; i++) {
    if (messages[i].type !== 'assistant') continue;
    const msg = messages[i];
    if (!msg.message || !Array.isArray(msg.message.content)) continue;
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) recentText = block.text.trim();
      if (block.type !== 'tool_use') continue;
      if (block.name === 'Edit' && block.input) {
        const file = block.input.file_path || block.input.file || '';
        const oldLines = block.input.old_string ? block.input.old_string.split('\n').length : 0;
        const newLines = block.input.new_string ? block.input.new_string.split('\n').length : 0;
        changes.push(`- 编辑: ${formatFilePath(file)} | +${newLines}/-${oldLines} 行 | ${recentText.split('\n')[0].slice(0, 80) || '-'}`);
      }
      if (block.name === 'Write' && block.input) {
        const file = block.input.file_path || block.input.file || '';
        const newLines = block.input.content ? block.input.content.split('\n').length : 0;
        changes.push(`- 新建: ${formatFilePath(file)} | +${newLines} 行 | ${recentText.split('\n')[0].slice(0, 80) || '-'}`);
      }
      if (block.name === 'Bash' && block.input && block.input.command) {
        for (const f of extractBashFileOps(block.input.command)) {
          changes.push(`- Shell: ${formatFilePath(f)} | ${recentText.split('\n')[0].slice(0, 80) || '-'}`);
        }
      }
    }
  }
  return changes;
}

function extractTokenUsage(messages, startIdx, endIdx) {
  const totals = { input: 0, output: 0, total: 0 };
  const seen = new Set();
  for (let i = startIdx; i <= endIdx; i++) {
    const entry = messages[i];
    if (!entry || entry.type !== 'assistant' || !entry.message) continue;
    const id = entry.message.id || entry.uuid || String(i);
    if (seen.has(id)) continue;
    seen.add(id);
    const usage = entry.message.usage || {};
    totals.input += toInt(usage.input_tokens);
    totals.output += toInt(usage.output_tokens);
  }
  totals.total = totals.input + totals.output;
  return totals;
}

function isSystemMessage(text) {
  if (!text) return true;
  if (text.startsWith('This session is being continued')) return true;
  if (text.startsWith('<command-name>')) return true;
  if (text.startsWith('<local-command-stdout>')) return true;
  if (text.startsWith('<local-command-caveat>')) return true;
  if (text.startsWith('<task-notification>')) return true;
  if (text.startsWith('<command-message>')) return true;
  return false;
}

function formatFilePath(filePath) {
  if (!filePath) return '?';
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length <= 3 ? parts.join('/') : '.../' + parts.slice(-3).join('/');
}

function extractBashFileOps(command) {
  if (!command) return [];
  const files = [];
  const re = />>?\s*['"]?([^\s';|&"']+)/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    if (m[1] && m[1] !== '&') files.push(m[1]);
  }
  if (/\bsed\s+/.test(command) && /-i/.test(command)) {
    const parts = command.trim().split(/\s+/);
    const last = parts[parts.length - 1].replace(/^['"]|['"]$/g, '');
    if (last && !last.startsWith('-')) files.push(last);
  }
  const teeMatch = command.match(/\btee\s+(?:"([^"]+)"|'([^']+)'|([^\s';|&]+))/);
  if (teeMatch) files.push(teeMatch[1] || teeMatch[2] || teeMatch[3]);
  const cpMvMatch = command.match(/\b(?:cp|mv)\s+(?:--?\S+\s+)*\S+\s+(\S+)\s*$/);
  if (cpMvMatch) files.push(cpMvMatch[1].replace(/^['"]|['"]$/g, ''));
  return [...new Set(files)];
}

function findProjectCwd(messages) {
  const msg = messages.find(m => m.type === 'user' && m.promptId && m.cwd);
  return msg ? msg.cwd : null;
}

function getCclogsBase(claudeDir) {
  return path.join(claudeDir, 'cclogs');
}

function isAlreadyLogged(logFile, userText) {
  if (!userText || !fs.existsSync(logFile)) return false;
  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    return content.includes(userText.slice(0, 60));
  } catch { return false; }
}

function toInt(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function fmtToken(v) { return v >= 1000 ? `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(v); }
