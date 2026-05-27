// 安全相關 middleware：Origin/Referer 檢查、登入頻率限制
const config = require('./config');
const logger = require('./logger');

// === Origin / Referer 檢查（CSRF 防護的補強）===
// 與 cookie SameSite=Strict 雙保險：拒絕跨站 POST/PUT/DELETE
function originCheck({ allowedHosts = [] } = {}) {
    const allowSet = new Set(allowedHosts.map(h => h.toLowerCase()));

    return function (req, res, next) {
        const method = req.method.toUpperCase();
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
            return next();
        }

        const origin = req.get('origin');
        const referer = req.get('referer');
        const host = (req.get('host') || '').toLowerCase();

        const candidates = [];
        if (origin) {
            try { candidates.push(new URL(origin).host.toLowerCase()); } catch {}
        }
        if (referer) {
            try { candidates.push(new URL(referer).host.toLowerCase()); } catch {}
        }

        // 容許清單：本機 host + 設定中的額外 host
        const allowed = new Set([host, ...allowSet]);

        // 嚴格模式：必須有 Origin 或 Referer，且其 host 必須在容許清單內
        if (candidates.length === 0) {
            logger.warn(`[origin-check] 拒絕無 Origin/Referer 的 ${method} ${req.path} from ${req.ip}`);
            return res.status(403).json({ success: false, error: '請求來源驗證失敗' });
        }

        const ok = candidates.some(h => allowed.has(h));
        if (!ok) {
            logger.warn(`[origin-check] 拒絕跨站 ${method} ${req.path}：origin=${origin} referer=${referer} host=${host}`);
            return res.status(403).json({ success: false, error: '請求來源不在允許清單' });
        }

        next();
    };
}

// === 登入頻率限制：以 IP + username 為 key 的記憶體計數器 ===
// 不引入 express-rate-limit（避免額外相依），自行實作簡單版本
function createLoginRateLimiter() {
    const buckets = new Map(); // key -> { count, resetAt }
    const WINDOW = config.LOGIN_RATE_LIMIT_WINDOW_MS;
    const MAX = config.LOGIN_RATE_LIMIT_MAX;

    // 定期清理過期 bucket，避免記憶體無限增長
    const cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [k, v] of buckets) {
            if (v.resetAt <= now) buckets.delete(k);
        }
    }, Math.max(WINDOW, 60_000));
    cleanupTimer.unref && cleanupTimer.unref();

    function middleware(req, res, next) {
        const ip = (req.ip || req.connection.remoteAddress || 'unknown').toString();
        const username = (req.body && req.body.username ? String(req.body.username) : '').toLowerCase();
        const key = `${ip}|${username}`;
        const now = Date.now();
        let bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + WINDOW };
            buckets.set(key, bucket);
        }
        bucket.count += 1;

        const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
        res.set('X-RateLimit-Limit', String(MAX));
        res.set('X-RateLimit-Remaining', String(Math.max(0, MAX - bucket.count)));

        if (bucket.count > MAX) {
            res.set('Retry-After', String(retryAfterSec));
            logger.warn(`[rate-limit] /login 阻擋：ip=${ip} username=${username || '-'} count=${bucket.count}`);
            if (req.path.startsWith('/api/')) {
                return res.status(429).json({ success: false, error: '嘗試次數過多，請稍後再試' });
            }
            return res.status(429).send(`<h2>登入嘗試次數過多</h2><p>請於 ${retryAfterSec} 秒後再試。</p>`);
        }

        next();
    }

    middleware._stop = () => clearInterval(cleanupTimer);
    return middleware;
}

// === 安全 HTTP 標頭（自行實作，避免引入 helmet 與 CSP 衝突） ===
// EJS 模板大量內嵌 <script>/style，CSP 預設會擋掉，因此這裡保守只設關鍵防護
function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    // HSTS 僅在 HTTPS 啟用（透過 trust proxy + req.secure 判定）
    if (req.secure) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
}

module.exports = { originCheck, createLoginRateLimiter, securityHeaders };
