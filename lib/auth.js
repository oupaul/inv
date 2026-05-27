// 認證 / 授權中介軟體：抽自 server.js，集中維護
const logger = require('./logger');

function makeAuthMiddleware({ getSystemSetting, logActivity, flash }) {
    function requireAuth(req, res, next) {
        const isApiRoute = req.path.startsWith('/api/');
        if (req.session && req.session.user) {
            const forceLogoutMinutes = parseInt(getSystemSetting('force_logout_minutes', '480'));
            const loginTime = req.session.user.loginTime || Date.now();
            const sessionDuration = (Date.now() - loginTime) / 1000 / 60;

            if (sessionDuration > forceLogoutMinutes) {
                logActivity(req, 'logout', `使用者 ${req.session.user.username} 因超過強制登出時間而登出`, 'user', req.session.user.id);
                req.session.destroy((err) => {
                    if (err) logger.error('強制登出錯誤:', err);
                    if (isApiRoute) {
                        return res.status(401).json({ success: false, error: '登入已逾時，請重新登入' });
                    }
                    res.redirect('/login');
                });
                return;
            }
            return next();
        }
        if (isApiRoute) {
            return res.status(401).json({ success: false, error: '請先登入' });
        }
        flash(req, 'error', '請先登入');
        res.redirect('/login');
    }

    function requireAdmin(req, res, next) {
        if (req.session && req.session.user && req.session.user.role === 'admin') {
            return next();
        }
        if (req.path.startsWith('/api/') ||
            req.path.startsWith('/parts/toggle-status/') ||
            req.path.startsWith('/parts/batch-delete')) {
            return res.status(403).json({ success: false, error: '需要管理員權限' });
        }
        flash(req, 'error', '需要管理員權限');
        res.redirect('/');
    }

    // 全域認證守門：未列於白名單的路徑一律要求登入
    // 注意：要在 session middleware 之後、所有路由之前掛上
    function makeGlobalAuthGuard({ publicPaths = [], publicPrefixes = [] }) {
        const exactSet = new Set(publicPaths);
        return function globalAuthGuard(req, res, next) {
            if (exactSet.has(req.path)) return next();
            for (const prefix of publicPrefixes) {
                if (req.path.startsWith(prefix)) return next();
            }
            return requireAuth(req, res, next);
        };
    }

    return { requireAuth, requireAdmin, makeGlobalAuthGuard };
}

module.exports = { makeAuthMiddleware };
