process.on('uncaughtException', (e) => {
  process.stderr.write('[codex-auto-log] uncaught: ' + (e && e.message) + '\n');
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  process.stderr.write('[codex-auto-log] unhandled rejection: ' + (e && e.message) + '\n');
  process.exit(1);
});

const fs = require('fs');
const path = require('path');
const os = require('os');

function isEnabled() {
  const claudeDir = process.env.CLAUDE_AUTO_LOG_HOME || path.join(os.homedir(), '.claude');
  const base = fs.existsSync(claudeDir) ? path.join(claudeDir, 'cclogs') : path.join(os.homedir(), '.codex', 'cclogs');
  return fs.existsSync(path.join(base, '.enabled'));
}

let chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  try {
    if (!isEnabled()) process.exit(0);

    const raw = Buffer.concat(chunks).toString();
    const payload = JSON.parse(raw);
    const hookEvent = payload.hook_event_name || 'Stop';
    const sessionId = payload.session_id;
    const cwd = payload.cwd;

    if (!sessionId || !cwd) process.exit(0);

    const cclogsBase = getCclogsBase();
    const logDir = path.join(cclogsBase, new Date().toISOString().slice(0, 10));
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const projectName = path.basename(cwd.replace(/\\/g, '/'));
    const logFile = path.join(logDir, `codex-${projectName}.md`);

    if (hookEvent === 'Stop') {
      handleStop(payload, logFile);
    } else if (hookEvent === 'UserPromptSubmit') {
      handleUserPromptSubmit(payload, logFile);
    }
  } catch {}
});

// ── Stop event ──

function handleStop(payload, logFile) {
  const transcriptPath = payload.transcript_path;
  const lastAssistantMsg = payload.last_assistant_message || '';

  if (transcriptPath && fs.existsSync(transcriptPath)) {
    const entries = parseTranscript(transcriptPath);
    const turn = findLastCompletedTurn(entries);
    if (turn) {
      const userText = cleanUserText(turn.userText) || '';
      const assistantText = lastAssistantMsg || turn.assistantText || '';
      if (!userText && !assistantText) process.exit(0);
      if (isAlreadyLogged(logFile, turn.turnId)) process.exit(0);
      const tokenUsage = turn.tokenUsage || { input: 0, output: 0, total: 0 };
      const codeChanges = extractCodeChanges(entries, turn.startIdx, turn.endIdx);
      writeLogEntry(logFile, userText, assistantText, codeChanges, tokenUsage, turn.duration, turn.turnId);
      process.exit(0);
    }
  }

  const userText = payload.prompt || '';
  if (!userText && !lastAssistantMsg) process.exit(0);
  writeLogEntry(logFile, userText, lastAssistantMsg, [], { input: 0, output: 0, total: 0 }, -1, null);
  process.exit(0);
}

// ── UserPromptSubmit event ──

function handleUserPromptSubmit(payload, logFile) {
  const transcriptPath = payload.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

  const entries = parseTranscript(transcriptPath);
  const turn = findLastCompletedTurn(entries, false);
  if (!turn) process.exit(0);

  const userText = cleanUserText(turn.userText) || '';
  const assistantText = turn.assistantText || '';
  if (!userText && !assistantText) process.exit(0);
  if (isAlreadyLogged(logFile, turn.turnId)) process.exit(0);

  const tokenUsage = turn.tokenUsage || { input: 0, output: 0, total: 0 };
  const codeChanges = extractCodeChanges(entries, turn.startIdx, turn.endIdx);
  writeLogEntry(logFile, userText, assistantText, codeChanges, tokenUsage, turn.duration, turn.turnId);
  process.exit(0);
}

// ── Transcript parsing (Codex JSONL format) ──

function parseTranscript(transcriptPath) {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  return content.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ── Turn-based parsing ──
// Splits transcript into turns by task_started boundaries.
// Each turn has its own userText, assistantText, tokenUsage, duration.

function parseTurns(entries) {
  const turns = [];
  let current = null;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== 'event_msg') continue;
    const p = e.payload || {};

    if (p.type === 'task_started') {
      current = {
        turnId: p.turn_id,
        userText: '',
        assistantText: '',
        tokenUsage: null,
        duration: -1,
        startIdx: i,
        endIdx: i,
        completed: false,
      };
      turns.push(current);
    } else if (current) {
      current.endIdx = i;
      if (p.type === 'user_message' && !current.userText) {
        current.userText = p.message || '';
      } else if (p.type === 'agent_message') {
        current.assistantText = p.message || '';
      } else if (p.type === 'token_count') {
        const usage = (p.info && p.info.last_token_usage) || {};
        current.tokenUsage = {
          input: toInt(usage.input_tokens) - toInt(usage.cached_input_tokens),
          output: toInt(usage.output_tokens),
          total: toInt(usage.input_tokens) + toInt(usage.output_tokens),
        };
      } else if (p.type === 'task_complete') {
        current.completed = true;
        current.duration = p.duration_ms ? Math.round(p.duration_ms / 1000) : -1;
      }
    }
  }

  return turns;
}

function findLastCompletedTurn(entries, allowIncomplete = true) {
  const turns = parseTurns(entries);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].completed) return turns[i];
  }
  return allowIncomplete && turns.length > 0 ? turns[turns.length - 1] : null;
}

function cleanUserText(text) {
  if (!text) return '';
  if (text.startsWith('<')) return '';
  return text;
}

// ── Code change extraction from response_item entries ──

function extractCodeChanges(entries, startIdx, endIdx) {
  const changes = [];
  let lastText = '';

  for (let i = startIdx; i <= endIdx; i++) {
    const e = entries[i];
    if (e.type !== 'response_item') continue;
    const p = e.payload || {};
    if (p.type !== 'message' || p.role !== 'assistant') continue;

    const content = p.content || [];
    for (const block of content) {
      if (block.type === 'output_text' && block.text) {
        lastText = block.text.trim();
      }
      if (block.type === 'function_call' && block.name) {
        const input = block.arguments || {};
        if (block.name === 'apply_patch' && input.command) {
          for (const info of parseApplyPatch(input.command)) {
            changes.push(`- 编辑: ${formatFilePath(info.file)} | +${info.added}/-${info.removed} 行 | ${lastText.split('\n')[0].slice(0, 80) || '-'}`);
          }
        }
        if (block.name === 'shell' && input.command) {
          for (const f of extractBashFileOps(input.command)) {
            changes.push(`- Shell: ${formatFilePath(f)} | ${lastText.split('\n')[0].slice(0, 80) || '-'}`);
          }
        }
      }
    }
  }
  return changes;
}

// ── apply_patch parser ──

function parseApplyPatch(command) {
  const results = [];
  if (!command) return results;

  const plusRegex = /^\+\+\+\s+b\/(.+?)\s*$/gm;
  const files = [];
  let m;
  while ((m = plusRegex.exec(command)) !== null) files.push(m[1]);

  if (files.length === 0) {
    const headerRegex = /^---\s+(\S+)\s*$/gm;
    while ((m = headerRegex.exec(command)) !== null) {
      if (m[1] !== '/dev/null') files.push(m[1].replace(/^a\//, ''));
    }
  }

  let totalAdded = 0, totalRemoved = 0;
  for (const line of command.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) totalAdded++;
    if (line.startsWith('-') && !line.startsWith('---')) totalRemoved++;
  }

  if (files.length > 0) {
    for (const file of files) results.push({ file, added: totalAdded, removed: totalRemoved });
  } else if (totalAdded > 0 || totalRemoved > 0) {
    results.push({ file: '?', added: totalAdded, removed: totalRemoved });
  }
  return results;
}

// ── Log entry builder ──

function writeLogEntry(logFile, userText, assistantText, codeChanges, tokenUsage, duration, turnId) {
  const now = new Date();
  const timeStr = now.toTimeString().slice(0, 8);
  let entry = `## [对话记录] ${timeStr}`;
  if (typeof duration === 'number' && duration >= 0) {
    const min = Math.floor(duration / 60);
    const sec = duration % 60;
    entry += ` | 耗时: ${min > 0 ? min + 'm' : ''}${sec}s`;
  }
  if (tokenUsage.total > 0) {
    entry += ` | 输入Token: ${fmtToken(tokenUsage.input)} | 输出Token: ${fmtToken(tokenUsage.output)} | 总计Token: ${fmtToken(tokenUsage.total)}`;
    entry += `\n<!-- token_stats input=${tokenUsage.input} output=${tokenUsage.output} total=${tokenUsage.total} -->`;
  }
  if (turnId) entry += `\n<!-- turn_id=${turnId} -->`;
  entry += `\n\n### 用户问题\n${userText || '(无)'}\n\n### Codex回答\n${assistantText || '(无)'}`;
  if (codeChanges.length > 0) entry += `\n\n### 代码变更\n${codeChanges.join('\n')}`;
  entry += `\n\n---\n\n`;
  fs.appendFileSync(logFile, entry, 'utf-8');
}

// ── Utility ──

function getCclogsBase() {
  const claudeDir = process.env.CLAUDE_AUTO_LOG_HOME || path.join(os.homedir(), '.claude');
  return fs.existsSync(claudeDir) ? path.join(claudeDir, 'cclogs') : path.join(os.homedir, '.codex', 'cclogs');
}
}

function isAlreadyLogged(logFile, turnId) {
  if (!turnId || !fs.existsSync(logFile)) return false;
  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    return content.includes(`turn_id=${turnId}`);
  } catch { return false; }
}

function extractBashFileOps(command) {
  if (!command) return [];
  const files = [];
  const re = />>?\s*['"]?([^\s';|&"']+)/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    if (m[1] && m[1] !== '&') files.push(m[1]);
  }
  return [...new Set(files)];
}

function formatFilePath(filePath) {
  if (!filePath) return '?';
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length <= 3 ? parts.join('/') : '.../' + parts.slice(-3).join('/');
}

function toInt(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function fmtToken(v) { return v >= 1000 ? `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(v); }
