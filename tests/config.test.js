// config.js 啟動驗證測試
const { test } = require('node:test');
const assert = require('node:assert/strict');

// 設置 NODE_ENV=development 並提供 SESSION_SECRET 後載入 config
process.env.NODE_ENV = 'development';
process.env.SESSION_SECRET = 'x'.repeat(40);
process.env.PORT = '6001';
const config = require('../lib/config');

test('config 從 env 讀取 PORT', () => {
    assert.equal(config.PORT, 6001);
});

test('config 從 env 讀取 SESSION_SECRET', () => {
    assert.ok(config.SESSION_SECRET);
    assert.ok(config.SESSION_SECRET.length >= 32);
});

test('config 有合理的預設 PAGE_SIZE', () => {
    assert.equal(typeof config.PAGE_SIZE, 'number');
    assert.ok(config.PAGE_SIZE > 0);
});

test('config 有 LOGIN rate limit 設定', () => {
    assert.equal(typeof config.LOGIN_RATE_LIMIT_MAX, 'number');
    assert.equal(typeof config.LOGIN_RATE_LIMIT_WINDOW_MS, 'number');
});
