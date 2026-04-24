const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const claudeDir = process.env.CLAUDE_AUTO_LOG_HOME || path.join(os.homedir(), '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');
if (!fs.existsSync(settingsPath)) {
  console.log('[Report] settings.json not found');
  process.exit(1);
}

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
const env = settings.env || {};
const apiKey = env.ANTHROPIC_AUTH_TOKEN;
const apiBase = env.ANTHROPIC_BASE_URL;
const model = env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6';

if (!apiKey || !apiBase) {
  console.log('[Report] No API config found in settings.json');
  process.exit(1);
}

const cclogsDir = path.join(claudeDir, 'cclogs');
const today = new Date().toISOString().slice(0, 10);
const todayDir = path.join(cclogsDir, today);

if (!fs.existsSync(todayDir)) {
  console.log('[日报] 今天没有对话记录: ' + todayDir);
  process.exit(0);
}

const logFiles = fs.readdirSync(todayDir).filter(f => f.endsWith('.md') && f !== 'daily-report.md');
if (logFiles.length === 0) {
  console.log('[日报] 今天没有任何项目日志');
  process.exit(0);
}

console.log('[日报] 找到 ' + logFiles.length + ' 个项目日志: ' + logFiles.join(', '));

let allContent = '';
for (const file of logFiles) {
  const filePath = path.join(todayDir, file);
  const content = fs.readFileSync(filePath, 'utf-8');
  const projectName = file.replace('.md', '');

  const editCount = (content.match(/^- 编辑:/gm) || []).length;
  const createCount = (content.match(/^- 新建:/gm) || []).length;
  const changedFiles = new Set();
  const fileRegex = /^- (?:编辑|新建): (.+?)(?: \||（)(.+)?$/gm;
  let m;
  while ((m = fileRegex.exec(content)) !== null) {
    changedFiles.add(m[1]);
  }

  const durationRegex = /耗时: (\d+m)?(\d+)s/g;
  let totalSec = 0;
  while ((m = durationRegex.exec(content)) !== null) {
    const min = m[1] ? parseInt(m[1]) : 0;
    const sec = parseInt(m[2]) || 0;
    totalSec += min * 60 + sec;
  }
  const totalMin = Math.round(totalSec / 60);

  let stats = `**代码变更**: 编辑 ${editCount} 个文件，新建 ${createCount} 个文件，共涉及 ${changedFiles.size} 个文件`;
  if (totalMin > 0) {
    stats += `\n**时间投入**: 约 ${totalMin} 分钟`;
  }

  allContent += `\n# 项目: ${projectName}\n\n${stats}\n\n${content}\n`;
}

const prompt = `你是一个工作日报生成助手。请根据以下今天的对话记录和代码变更记录，生成一份简洁的工作日报。

要求：
1. 用中文输出
2. 按项目分组总结
3. 每个项目列出：完成了什么、修改了哪些文件
4. 每个项目开头展示该项目的统计数据（代码变更文件数、时间投入），这些数据是精确统计的，直接引用
5. 如有未完成或进行中的工作，单独列出
6. 不要照搬原文，要提炼总结
7. 格式用 markdown

以下是对话记录：

${allContent}`;

generateReport(prompt).then(text => {
  const reportPath = path.join(todayDir, 'daily-report.md');
  const header = `# Daily Report ${today}\n\n`;
  fs.writeFileSync(reportPath, header + text, 'utf-8');
  console.log('[日报] 已生成: ' + reportPath);
}).catch(err => {
  console.log('[日报] 生成失败: ' + err.message);
  process.exit(1);
});

function generateReport(prompt) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiBase.replace(/\/+$/, '') + '/v1/messages');

    const body = JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const requester = url.protocol === 'https:' ? https : http;
    const req = requester.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const textBlock = Array.isArray(json.content)
            ? json.content.find(block => block && block.type === 'text' && typeof block.text === 'string')
            : null;
          if (textBlock) {
            resolve(textBlock.text);
          } else if (typeof json.output_text === 'string' && json.output_text) {
            resolve(json.output_text);
          } else if (json.error) {
            reject(new Error(json.error.message || JSON.stringify(json.error)));
          } else {
            reject(new Error('未知响应格式: ' + data.slice(0, 200)));
          }
        } catch {
          reject(new Error('解析响应失败: ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
