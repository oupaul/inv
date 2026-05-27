// 統一設定載入：所有環境變數、預設值與啟動時驗證集中於此
const path = require('path');
const crypto = require('crypto');

// ===== 時區 =====
// 全系統使用台灣時間（UTC+8）。在任何 Date 物件被使用前設定 process.env.TZ，
// 讓所有 JS 端的 new Date()、toLocaleString() 等都以台北時間運作。
// 可用 TZ 環境變數覆蓋（預設 Asia/Taipei）。
const TIMEZONE = process.env.TZ || 'Asia/Taipei';
process.env.TZ = TIMEZONE;

function parseIntEnv(name, defaultValue) {
    const raw = process.env[name];
    if (raw == null || raw === '') return defaultValue;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : defaultValue;
}

function parseBoolEnv(name, defaultValue) {
    const raw = process.env[name];
    if (raw == null || raw === '') return defaultValue;
    return /^(1|true|yes|on)$/i.test(raw);
}

// SESSION_SECRET 處理：
// - 生產環境必須由 env 提供
// - 開發環境若未設定，啟動時產生隨機字串（每次重啟登入會失效，提示使用者設定）
function resolveSessionSecret() {
    const fromEnv = process.env.SESSION_SECRET;
    if (fromEnv && fromEnv.length >= 32) return fromEnv;

    if (process.env.NODE_ENV === 'production') {
        console.error('❌ 啟動失敗：生產環境必須設定 SESSION_SECRET 環境變數（長度 >= 32）');
        console.error('   請在 .env 中加入：SESSION_SECRET=<請使用 openssl rand -hex 32 產生>');
        process.exit(1);
    }

    const generated = crypto.randomBytes(32).toString('hex');
    console.warn('⚠️  未設定 SESSION_SECRET，已自動產生臨時值。重啟後所有登入會失效。');
    console.warn('   請在 .env 中設定：SESSION_SECRET=' + generated);
    return generated;
}

const config = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    isProd: process.env.NODE_ENV === 'production',

    PORT: parseIntEnv('PORT', 5000),
    PAGE_TITLE: process.env.PAGE_TITLE || '庫存管理系統',

    DB_FILE: process.env.DB_FILE || 'inventory.db',
    SESSION_DB_FILE: process.env.SESSION_DB_FILE || 'sessions.db',
    BACKUP_DIR: process.env.BACKUP_DIR || path.join(process.cwd(), 'backups'),

    SESSION_SECRET: resolveSessionSecret(),
    SESSION_MAX_AGE_MS: parseIntEnv('SESSION_MAX_AGE_MINUTES', 24 * 60) * 60 * 1000,
    COOKIE_SECURE: parseBoolEnv('COOKIE_SECURE', process.env.NODE_ENV === 'production'),
    // SSO 授權碼流程的登入回呼是跨站 top-level 導向，需 SameSite=Lax 才會帶 session cookie。
    // 仍有 Origin 檢查擋 CSRF。可用 COOKIE_SAMESITE 覆蓋（strict/lax/none）。
    COOKIE_SAMESITE: (process.env.COOKIE_SAMESITE || 'lax').toLowerCase(),

    // ===== M365 / Entra ID SSO（OpenID Connect 授權碼流程）=====
    // 四個值齊全才會啟用 SSO。在 Entra App Registration 取得：
    //   SSO_TENANT_ID    租戶 ID
    //   SSO_CLIENT_ID    應用程式（用戶端）ID
    //   SSO_CLIENT_SECRET 用戶端密碼
    //   SSO_REDIRECT_URI 重新導向 URI，需與 Entra 設定完全一致（如 https://host/auth/callback）
    SSO_TENANT_ID: process.env.SSO_TENANT_ID || '',
    SSO_CLIENT_ID: process.env.SSO_CLIENT_ID || '',
    SSO_CLIENT_SECRET: process.env.SSO_CLIENT_SECRET || '',
    SSO_REDIRECT_URI: process.env.SSO_REDIRECT_URI || '',
    get SSO_ENABLED() {
        return !!(this.SSO_TENANT_ID && this.SSO_CLIENT_ID && this.SSO_CLIENT_SECRET && this.SSO_REDIRECT_URI);
    },

    PAGE_SIZE: parseIntEnv('PAGE_SIZE', 50),

    LOGIN_RATE_LIMIT_WINDOW_MS: parseIntEnv('LOGIN_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    LOGIN_RATE_LIMIT_MAX: parseIntEnv('LOGIN_RATE_LIMIT_MAX', 10),

    UPLOAD_EXCEL_MAX_BYTES: parseIntEnv('UPLOAD_EXCEL_MAX_BYTES', 10 * 1024 * 1024),
    UPLOAD_IMAGE_MAX_BYTES: parseIntEnv('UPLOAD_IMAGE_MAX_BYTES', 15 * 1024 * 1024),

    LOG_FILE: process.env.LOG_FILE || null,
    LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),

    // activity_logs 自動清理（保留天數；0 = 不清理）
    ACTIVITY_LOG_RETENTION_DAYS: parseIntEnv('ACTIVITY_LOG_RETENTION_DAYS', 90),

    TIMEZONE,
    TZ_OFFSET_HOURS: 8,   // 台灣 UTC+8（無日光節約），供 SQL datetime(col, '+8 hours') 顯示轉換
};

module.exports = config;
