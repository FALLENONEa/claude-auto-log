const fs = require('fs');
const path = require('path');
const os = require('os');

let chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    const sessionId = payload.session_id;
    const cwd = payload.cwd;

    if (!sessionId || !cwd) process.exit(0);

    const claudeDir = process.env.CLAUDE_AUTO_LOG_HOME || path.join(os.homedir(), '.claude');
    const projectsDir = path.join(claudeDir, 'projects');
    const sessionFile = findSessionFile(projectsDir, sessionId);

    if (!sessionFile) process.exit(0);

    const lines = fs.readFileSync(sessionFile, 'utf-8').split('\n').filter(Boolean);
    const messages = lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(m => m && (m.type === 'user' || m.type === 'assistant'));

    if (messages.length < 2) process.exit(0);

    let lastAssistant = null;
    let lastUser = null;
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!lastAssistant && messages[i].type === 'assistant') {
        lastAssistant = messages[i];
        lastAssistantIdx = i;
      } else if (lastAssistant) {
        break;
      }
    }

    for (let i = lastAssistantIdx - 1; i >= 0; i--) {
      if (messages[i].type === 'user' && messages[i].promptId && !messages[i].toolUseResult) {
        lastUser = messages[i];
        break;
      }
    }

    if (!lastUser || !lastAssistant) process.exit(0);

    const userText = extractText(lastUser.message);
    const assistantText = extractText(lastAssistant.message);

    const codeChanges = [];
    let recentText = '';
    const userIdx = messages.indexOf(lastUser);
    for (let i = userIdx; i <= lastAssistantIdx; i++) {
      if (messages[i].type === 'assistant') {
        const text = extractText(messages[i].message);
        if (text) recentText = text.trim();
        const changes = extractCodeChanges(messages[i].message, recentText);
        codeChanges.push(...changes);
      }
    }

    const tokenUsage = extractTokenUsage(messages, userIdx, lastAssistantIdx);

    if (!userText && !assistantText) process.exit(0);

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8);
    const firstUserMsg = messages.find(m => m.type === 'user' && m.promptId && m.cwd);
    const projectCwd = firstUserMsg ? firstUserMsg.cwd : cwd;
    const projectName = path.basename(projectCwd.replace(/\\/g, '/'));
    const logDir = path.join(claudeDir, 'cclogs', dateStr);

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logFile = path.join(logDir, `${projectName}.md`);

    let entry = `## [对话记录] ${timeStr}`;
    const userTime = new Date(lastUser.timestamp).getTime();
    const assistantTime = new Date(lastAssistant.timestamp).getTime();
    const duration = Math.round((assistantTime - userTime) / 1000);
    if (duration >= 0) {
      const min = Math.floor(duration / 60);
      const sec = duration % 60;
      entry += ` | 耗时: ${min > 0 ? min + 'm' : ''}${sec}s`;
    }

    if (tokenUsage.total > 0) {
      entry += ` | 输入Token: ${formatTokenCount(tokenUsage.input)} | 输出Token: ${formatTokenCount(tokenUsage.output)} | 总计Token: ${formatTokenCount(tokenUsage.total)}`;
      entry += `\n<!-- token_stats input=${tokenUsage.input} output=${tokenUsage.output} total=${tokenUsage.total} -->`;
    }

    entry += `\n\n### 用户问题\n${userText}\n\n### Claude回答\n${assistantText}`;

    if (codeChanges.length > 0) {
      entry += `\n\n### 代码变更\n${codeChanges.join('\n')}`;
    }

    entry += `\n\n---\n\n`;
    fs.appendFileSync(logFile, entry, 'utf-8');
  } catch {}
});

function findSessionFile(projectsDir, sessionId) {
  const filename = sessionId + '.jsonl';
  try {
    const dirs = fs.readdirSync(projectsDir);
    for (const dir of dirs) {
      const fullPath = path.join(projectsDir, dir, filename);
      if (fs.existsSync(fullPath)) return fullPath;
    }
  } catch {}
  return null;
}

function extractText(message) {
  if (!message || !message.content) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter(block => block.type === 'text' && block.text)
      .map(block => block.text)
      .join('\n');
  }
  return '';
}

function extractCodeChanges(message, fallbackText) {
  const changes = [];
  if (!message || !Array.isArray(message.content)) return changes;

  let lastText = fallbackText || '';
  for (const block of message.content) {
    if (block.type === 'text' && block.text) {
      lastText = block.text.trim();
    }

    if (block.type !== 'tool_use') continue;

    if (block.name === 'Edit' && block.input) {
      const file = block.input.file_path || block.input.file || '';
      const shortFile = path.basename(file);
      const oldLines = block.input.old_string ? block.input.old_string.split('\n').length : 0;
      const newLines = block.input.new_string ? block.input.new_string.split('\n').length : 0;
      const reason = lastText ? lastText.split('\n')[0].slice(0, 80) : '-';
      changes.push(`- 编辑: ${shortFile} | +${newLines}/-${oldLines} 行 | ${reason}`);
    }

    if (block.name === 'Write' && block.input) {
      const file = block.input.file_path || block.input.file || '';
      const shortFile = path.basename(file);
      const newLines = block.input.content ? block.input.content.split('\n').length : 0;
      const reason = lastText ? lastText.split('\n')[0].slice(0, 80) : '-';
      changes.push(`- 新建: ${shortFile} | +${newLines} 行 | ${reason}`);
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

    const responseId = entry.message.id || entry.uuid || String(i);
    if (seen.has(responseId)) continue;
    seen.add(responseId);

    const usage = entry.message.usage || {};
    totals.input += toInt(usage.input_tokens);
    totals.output += toInt(usage.output_tokens);
  }

  totals.total = totals.input + totals.output;
  return totals;
}

function toInt(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function formatTokenCount(value) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(value);
}
