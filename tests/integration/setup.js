// 整合測試共用設定：在 require server.js 之前強制注入測試用 env
// 重要：每個整合測試檔頂端必須先 require 這個檔案，否則 server.js 會使用正式 DB
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SESSION_SECRET = 'x'.repeat(64);

// 用 :memory: SQLite，每次 require 都是全新 DB（含 admin/admin123）
process.env.DB_FILE = ':memory:';
process.env.SESSION_DB_FILE = ':memory:';

// session 改用 MemoryStore：同 process 必定保持 session，避開 better-sqlite3-session-store
// 配 :memory: SQLite 在 supertest 下的 quirk（production 用真實 sessions.db 不受影響）
process.env.SESSION_STORE = 'memory';

// 關掉 rate limit 在測試中容易誤觸
process.env.LOGIN_RATE_LIMIT_MAX = '1000';

// supertest 直連 app 時 Host = 127.0.0.1:<隨機port>，但測試送的 Origin 是 http://localhost。
// 把 localhost / 127.0.0.1 列入 Origin 容許清單，讓同源測試請求通過（跨站 evil.com 仍會被擋）。
process.env.ALLOWED_HOSTS = 'localhost,127.0.0.1';

// 縮短 session 期限以便測逾時行為（測試不需要）
process.env.SESSION_MAX_AGE_MINUTES = '60';

// 關掉 LOG（避免測試輸出被淹沒）
process.env.LOG_LEVEL = 'error';

module.exports = {};
