// 簡易結構化 logger：支援 level、時間戳記、選擇性寫入檔案
// 維持與既有 console.* 相容（不強迫立即改寫全部呼叫點）
const fs = require('fs');
const path = require('path');
const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[config.LOG_LEVEL] || LEVELS.info;

let fileStream = null;
if (config.LOG_FILE) {
    try {
        const dir = path.dirname(config.LOG_FILE);
        if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fileStream = fs.createWriteStream(config.LOG_FILE, { flags: 'a' });
    } catch (e) {
        console.error('無法開啟 log 檔案:', e.message);
    }
}

function format(level, args) {
    const ts = new Date().toISOString();
    const parts = args.map(a => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch { return String(a); }
        }
        return String(a);
    });
    return `${ts} [${level.toUpperCase()}] ${parts.join(' ')}`;
}

let closed = false;
function write(level, args) {
    if (LEVELS[level] < minLevel) return;
    const line = format(level, args);
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    try { stream.write(line + '\n'); } catch {}
    if (fileStream && !closed && fileStream.writable) {
        try { fileStream.write(line + '\n'); } catch {}
    }
}

module.exports = {
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    close: () => { closed = true; if (fileStream) fileStream.end(); }
};
