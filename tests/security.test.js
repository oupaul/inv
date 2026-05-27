// security.js 中介軟體單元測試（不啟動 server）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { originCheck, securityHeaders } = require('../lib/security');

function mockReq({ method = 'POST', path = '/x', headers = {}, ip = '127.0.0.1' } = {}) {
    return {
        method,
        path,
        ip,
        get(name) { return headers[name.toLowerCase()]; },
        connection: { remoteAddress: ip }
    };
}

function mockRes() {
    const headers = {};
    return {
        statusCode: 200,
        headers,
        setHeader(k, v) { headers[k] = v; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

test('originCheck 允許 GET', () => {
    const mw = originCheck();
    const req = mockReq({ method: 'GET' });
    const res = mockRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.equal(called, true);
});

test('originCheck 拒絕缺少 Origin/Referer 的 POST', () => {
    const mw = originCheck();
    const req = mockReq({ method: 'POST' });
    const res = mockRes();
    mw(req, res, () => { throw new Error('不應該呼叫 next'); });
    assert.equal(res.statusCode, 403);
});

test('originCheck 接受同 host 的 Origin', () => {
    const mw = originCheck();
    const req = mockReq({ method: 'POST', headers: { origin: 'http://example.com', host: 'example.com' } });
    const res = mockRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.equal(called, true);
});

test('originCheck 拒絕跨站 Origin', () => {
    const mw = originCheck();
    const req = mockReq({ method: 'POST', headers: { origin: 'http://evil.com', host: 'example.com' } });
    const res = mockRes();
    mw(req, res, () => { throw new Error('不應該呼叫 next'); });
    assert.equal(res.statusCode, 403);
});

test('originCheck 額外允許清單', () => {
    const mw = originCheck({ allowedHosts: ['trusted.com'] });
    const req = mockReq({ method: 'POST', headers: { origin: 'http://trusted.com', host: 'example.com' } });
    const res = mockRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.equal(called, true);
});

test('securityHeaders 設定核心標頭', () => {
    const req = { secure: false };
    const res = mockRes();
    securityHeaders(req, res, () => {});
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(res.headers['X-Frame-Options'], 'SAMEORIGIN');
    assert.equal(res.headers['Referrer-Policy'], 'same-origin');
    assert.equal(res.headers['Strict-Transport-Security'], undefined);
});

test('securityHeaders 在 HTTPS 才加 HSTS', () => {
    const req = { secure: true };
    const res = mockRes();
    securityHeaders(req, res, () => {});
    assert.ok(res.headers['Strict-Transport-Security']);
});
