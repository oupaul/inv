// 使用者管理（僅管理員）
const argon2 = require('argon2');
const logger = require('../lib/logger');
const validators = require('../lib/validators');

module.exports = function mountUserRoutes(ctx) {
    const { app, db, config, flash, logActivity, requireAdmin } = ctx;
    const PAGE_TITLE = config.PAGE_TITLE;

    app.get('/users', requireAdmin, (req, res) => {
        const users = db.prepare(`
            SELECT u.id, u.username, u.full_name, u.email, u.role, u.is_active,
                   datetime(u.created_at, '+8 hours') as created_at,
                   COALESCE(r.display_name, u.role) as role_display_name
            FROM users u
            LEFT JOIN roles r ON u.role = r.role_name
            ORDER BY u.created_at DESC
        `).all();
        const roles = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, display_name').all();
        logActivity(req, 'view', '查看使用者列表', 'users', null);
        res.render('users_list', { users, roles, title: PAGE_TITLE });
    });

    app.get('/users/add', requireAdmin, (req, res) => {
        try {
            const roles = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, display_name').all();
            res.render('add_user', { title: PAGE_TITLE, roles });
        } catch (error) {
            logger.error('載入新增使用者頁面錯誤:', error);
            flash(req, 'error', '載入頁面失敗');
            res.redirect('/users');
        }
    });

    app.post('/users/add', requireAdmin, async (req, res) => {
        const { username, password, full_name, email, role, force_password_change } = req.body;
        const v = validators.check([
            ['username', validators.rules.username(username)],
            ['password', validators.rules.password(password)],
            ['email', validators.rules.email(email, { optional: true })]
        ]);
        if (!v.ok) {
            flash(req, 'error', v.errors[0].message);
            return res.redirect('/users/add');
        }
        try {
            const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
            const forceChange = force_password_change === 'on' ? 1 : 0;
            const result = db.prepare(`
                INSERT INTO users (username, password_hash, full_name, email, role, force_password_change)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(username, passwordHash, full_name || null, email || null, role || 'user', forceChange);
            logActivity(req, 'create', `新增使用者：${username}${forceChange ? '（需首次變更密碼）' : ''}`, 'user', result.lastInsertRowid);
            flash(req, 'success', '用戶新增成功！');
            res.redirect('/users');
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') flash(req, 'error', '帳號已存在！');
            else flash(req, 'error', `新增失敗：${error.message}`);
            res.redirect('/users/add');
        }
    });

    app.get('/users/edit/:id', requireAdmin, (req, res) => {
        const { id } = req.params;
        try {
            const user = db.prepare('SELECT id, username, full_name, email, role, is_active FROM users WHERE id = ?').get(id);
            if (!user) {
                flash(req, 'error', '用戶不存在！');
                return res.redirect('/users');
            }
            const roles = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, display_name').all();
            res.render('edit_user', { user, title: PAGE_TITLE, roles });
        } catch (error) {
            logger.error('載入編輯使用者頁面錯誤:', error);
            flash(req, 'error', '載入頁面失敗');
            res.redirect('/users');
        }
    });

    app.post('/users/edit/:id', requireAdmin, async (req, res) => {
        const { id } = req.params;
        const { username, password, full_name, email, role, is_active } = req.body;
        try {
            if (role) {
                const roleExists = db.prepare('SELECT role_name FROM roles WHERE role_name = ?').get(role);
                if (!roleExists) {
                    flash(req, 'error', `角色 "${role}" 不存在！`);
                    return res.redirect(`/users/edit/${id}`);
                }
            }
            const finalRole = role && role.trim() !== '' ? role.trim() : 'user';
            const isActiveValue = (is_active === '1' || is_active === 1 || is_active === true) ? 1 : 0;

            if (password && password.trim() !== '') {
                const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
                db.prepare(`
                    UPDATE users SET username = ?, password_hash = ?, full_name = ?, email = ?,
                                     role = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(username, passwordHash, full_name || null, email || null, finalRole, isActiveValue, id);
            } else {
                db.prepare(`
                    UPDATE users SET username = ?, full_name = ?, email = ?, role = ?,
                                     is_active = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(username, full_name || null, email || null, finalRole, isActiveValue, id);
            }

            logActivity(req, 'update', `編輯使用者：${username}（角色：${finalRole}）`, 'user', parseInt(id));
            flash(req, 'success', '用戶更新成功！');
            res.redirect('/users');
        } catch (error) {
            logger.error('更新使用者錯誤:', error);
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') flash(req, 'error', '帳號已存在！');
            else flash(req, 'error', `更新失敗：${error.message}`);
            res.redirect(`/users/edit/${id}`);
        }
    });

    app.post('/users/delete/:id', requireAdmin, (req, res) => {
        const { id } = req.params;
        if (parseInt(id) === req.session.user.id) {
            flash(req, 'error', '無法刪除自己的帳號！');
            return res.redirect('/users');
        }
        try {
            const user = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
            const username = user ? user.username : '未知';
            db.prepare('DELETE FROM users WHERE id = ?').run(id);
            logActivity(req, 'delete', `刪除使用者：${username}`, 'user', parseInt(id));
            flash(req, 'success', '用戶刪除成功！');
            res.redirect('/users');
        } catch (error) {
            flash(req, 'error', `刪除失敗：${error.message}`);
            res.redirect('/users');
        }
    });
};
