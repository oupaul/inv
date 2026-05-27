// 認證相關路由：登入、登出、修改密碼
const argon2 = require('argon2');
const logger = require('../lib/logger');
const validators = require('../lib/validators');

module.exports = function mountAuthRoutes(ctx) {
    const { app, db, config, flash, logActivity, loginRateLimiter } = ctx;
    const PAGE_TITLE = config.PAGE_TITLE;

    // 登入頁面（不需要認證；由全域 PUBLIC_PATHS 放行）
    app.get('/login', (req, res) => {
        if (req.session.user) return res.redirect('/');
        res.render('login', { title: PAGE_TITLE, user: null });
    });

    // 登入處理（前置 rate limiter）
    app.post('/login', loginRateLimiter, async (req, res) => {
        const { username, password } = req.body;

        const v = validators.check([
            ['username', validators.rules.username(username)],
            ['password', validators.rules.password(password)]
        ]);
        if (!v.ok) {
            flash(req, 'error', v.errors[0].message);
            return res.redirect('/login');
        }

        try {
            const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username.trim());

            if (!user) {
                // 等時間：避免時間側通道洩漏帳號是否存在
                await argon2.hash(password, { type: argon2.argon2id }).catch(() => null);
                flash(req, 'error', '帳號或密碼錯誤');
                return res.redirect('/login');
            }

            const isValid = await argon2.verify(user.password_hash, password);
            if (!isValid) {
                flash(req, 'error', '帳號或密碼錯誤');
                return res.redirect('/login');
            }

            // 取得角色權限
            let userPermissions = {};
            if (user.role) {
                const role = db.prepare('SELECT permissions FROM roles WHERE role_name = ?').get(user.role);
                if (role && role.permissions) {
                    try { userPermissions = JSON.parse(role.permissions); }
                    catch (e) { logger.error('解析權限失敗:', e); userPermissions = {}; }
                }
            }

            req.session.user = {
                id: user.id,
                username: user.username,
                full_name: user.full_name,
                email: user.email,
                role: user.role,
                permissions: userPermissions,
                loginTime: Date.now(),
                mustChangePassword: user.force_password_change === 1
            };

            logActivity(req, 'login', `使用者 ${user.username} 登入系統`, 'user', user.id);

            if (user.force_password_change === 1) {
                flash(req, 'warning', '您是首次登入，系統要求您立即變更密碼。');
                return res.redirect('/change-password');
            }

            flash(req, 'success', `歡迎回來，${user.full_name || user.username}！`);
            res.redirect('/');
        } catch (error) {
            logger.error('登入失敗:', error);
            flash(req, 'error', `登入失敗：${error.message}`);
            res.redirect('/login');
        }
    });

    // 登出
    app.post('/logout', (req, res) => {
        if (req.session.user) {
            logActivity(req, 'logout', `使用者 ${req.session.user.username} 登出系統`, 'user', req.session.user.id);
        }
        req.session.destroy((err) => {
            if (err) logger.error('登出錯誤:', err);
            res.redirect('/login');
        });
    });

    // 修改密碼頁面
    app.get('/change-password', (req, res) => {
        try {
            res.render('change_password', {
                title: PAGE_TITLE,
                isForced: req.session.user && req.session.user.mustChangePassword === true
            });
        } catch (error) {
            logger.error('載入修改密碼頁面錯誤:', error);
            flash(req, 'error', '載入頁面失敗');
            res.redirect('/');
        }
    });

    // 修改密碼處理
    app.post('/change-password', async (req, res) => {
        const { current_password, new_password, confirm_password } = req.body;
        const userId = req.session.user.id;

        try {
            if (!current_password || !new_password || !confirm_password) {
                flash(req, 'error', '請填寫所有必填欄位');
                return res.redirect('/change-password');
            }
            if (new_password.length < 6) {
                flash(req, 'error', '新密碼長度至少需要 6 個字元');
                return res.redirect('/change-password');
            }
            if (new_password !== confirm_password) {
                flash(req, 'error', '新密碼與確認密碼不相符');
                return res.redirect('/change-password');
            }
            if (current_password === new_password) {
                flash(req, 'error', '新密碼不能與目前密碼相同');
                return res.redirect('/change-password');
            }

            const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
            if (!user) {
                flash(req, 'error', '使用者不存在');
                return res.redirect('/change-password');
            }

            const isValid = await argon2.verify(user.password_hash, current_password);
            if (!isValid) {
                flash(req, 'error', '目前密碼錯誤');
                return res.redirect('/change-password');
            }

            const newPasswordHash = await argon2.hash(new_password, { type: argon2.argon2id });
            db.prepare(`
                UPDATE users
                SET password_hash = ?, force_password_change = 0, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(newPasswordHash, userId);

            if (req.session.user) req.session.user.mustChangePassword = false;
            logActivity(req, 'update', '修改密碼', 'user', userId);

            flash(req, 'success', '密碼修改成功！');
            res.redirect('/');
        } catch (error) {
            logger.error('修改密碼錯誤:', error);
            flash(req, 'error', '修改密碼失敗，請稍後再試');
            res.redirect('/change-password');
        }
    });
};
