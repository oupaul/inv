// M365 / Entra ID SSO 路由：/auth/sso（發起）與 /auth/callback（回呼）
const crypto = require('crypto');
const logger = require('../lib/logger');
const { createSso, resolveUserByEmail } = require('../lib/sso');
const { buildSessionUser } = require('../lib/auth');

module.exports = function mountSsoRoutes(ctx) {
    const { app, db, flash, logActivity } = ctx;
    const sso = createSso();

    // 未啟用 SSO：兩個端點都導回登入頁並提示（避免 404 困惑）
    if (!sso.enabled) {
        app.get('/auth/sso', (req, res) => {
            flash(req, 'error', '系統未啟用 M365 登入');
            res.redirect('/login');
        });
        return;
    }

    // 發起 SSO：產生 state 存 session，導向 Entra
    app.get('/auth/sso', async (req, res) => {
        try {
            const state = crypto.randomBytes(16).toString('hex');
            req.session.ssoState = state;
            const url = await sso.getAuthUrl(state);
            res.redirect(url);
        } catch (e) {
            logger.error('SSO 發起失敗:', e);
            flash(req, 'error', 'M365 登入發起失敗，請稍後再試');
            res.redirect('/login');
        }
    });

    // 回呼：驗證 state → 換 token → 取 email → 比對使用者 → 建立 session
    app.get('/auth/callback', async (req, res) => {
        const { code, state, error, error_description } = req.query;

        if (error) {
            logger.warn(`SSO 回呼錯誤：${error} - ${error_description || ''}`);
            flash(req, 'error', `M365 登入失敗：${error_description || error}`);
            return res.redirect('/login');
        }

        // state 驗證（防 CSRF）
        const expected = req.session.ssoState;
        delete req.session.ssoState;
        if (!code || !state || !expected || state !== expected) {
            flash(req, 'error', 'M365 登入驗證失敗（state 不符），請重試');
            return res.redirect('/login');
        }

        try {
            const { email, name } = await sso.exchangeCode(code);
            if (!email) {
                flash(req, 'error', '無法從 M365 取得 Email，登入失敗');
                return res.redirect('/login');
            }

            // 政策：必須事先建立且啟用、email 相符
            const user = resolveUserByEmail(db, email);
            if (!user) {
                logger.warn(`SSO 拒絕：未授權的 M365 帳號 ${email}`);
                flash(req, 'error', `此 M365 帳號（${email}）尚未授權使用本系統，請聯絡管理員建立帳號。`);
                return res.redirect('/login');
            }

            req.session.user = buildSessionUser(db, user);
            req.session.user.authMethod = 'sso';
            logActivity(req, 'login', `使用者 ${user.username} 透過 M365 SSO 登入（${email}）`, 'user', user.id);

            if (req.session.user.mustChangePassword) {
                flash(req, 'warning', '請先設定/變更密碼。');
                return res.redirect('/change-password');
            }
            flash(req, 'success', `歡迎回來，${user.full_name || user.username}！`);
            res.redirect('/');
        } catch (e) {
            logger.error('SSO 回呼處理失敗:', e);
            flash(req, 'error', 'M365 登入處理失敗，請稍後再試');
            res.redirect('/login');
        }
    });
};
