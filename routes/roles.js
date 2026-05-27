// 角色管理（僅管理員）
const logger = require('../lib/logger');

module.exports = function mountRoleRoutes(ctx) {
    const { app, db, config, flash, logActivity, requireAdmin } = ctx;
    const PAGE_TITLE = config.PAGE_TITLE;

    app.get('/roles', requireAdmin, (req, res) => {
        try {
            const roles = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, role_name').all();
            logActivity(req, 'view', '查看角色列表', 'roles', null);
            res.render('roles_list', { title: PAGE_TITLE, roles });
        } catch (error) {
            logger.error('載入角色列表錯誤:', error);
            flash(req, 'error', '載入角色列表失敗');
            res.redirect('/');
        }
    });

    app.get('/roles/add', requireAdmin, (req, res) => {
        try {
            res.render('add_role', { title: PAGE_TITLE });
        } catch (error) {
            logger.error('載入新增角色頁面錯誤:', error);
            flash(req, 'error', '載入頁面失敗');
            res.redirect('/roles');
        }
    });

    app.post('/roles/add', requireAdmin, (req, res) => {
        const { role_name, display_name, description, permissions } = req.body;
        try {
            if (!role_name || !display_name) {
                flash(req, 'error', '請填寫角色名稱和顯示名稱');
                return res.redirect('/roles/add');
            }
            const permissionsObj = {};
            if (permissions && Array.isArray(permissions)) {
                permissions.forEach(perm => {
                    const [mod, action] = perm.split(':');
                    if (!permissionsObj[mod]) permissionsObj[mod] = [];
                    permissionsObj[mod].push(action);
                });
            }
            const result = db.prepare(`
                INSERT INTO roles (role_name, display_name, description, permissions, is_system)
                VALUES (?, ?, ?, ?, 0)
            `).run(role_name.toLowerCase().trim(), display_name.trim(), description || null, JSON.stringify(permissionsObj));
            logActivity(req, 'create', `新增角色：${display_name}`, 'role', result.lastInsertRowid);
            flash(req, 'success', '角色新增成功！');
            res.redirect('/roles');
        } catch (error) {
            logger.error('新增角色錯誤:', error);
            flash(req, 'error', error.message.includes('UNIQUE') ? '角色名稱已存在' : '新增角色失敗');
            res.redirect('/roles/add');
        }
    });

    app.get('/roles/edit/:id', requireAdmin, (req, res) => {
        try {
            const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
            if (!role) {
                flash(req, 'error', '角色不存在');
                return res.redirect('/roles');
            }
            res.render('edit_role', { title: PAGE_TITLE, role });
        } catch (error) {
            logger.error('載入編輯角色頁面錯誤:', error);
            flash(req, 'error', '載入頁面失敗');
            res.redirect('/roles');
        }
    });

    app.post('/roles/edit/:id', requireAdmin, (req, res) => {
        const { role_name, display_name, description, permissions } = req.body;
        const roleId = req.params.id;
        try {
            const existing = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
            if (!existing) {
                flash(req, 'error', '角色不存在');
                return res.redirect('/roles');
            }
            if (!display_name) {
                flash(req, 'error', '請填寫顯示名稱');
                return res.redirect(`/roles/edit/${roleId}`);
            }
            const permissionsObj = {};
            if (permissions && Array.isArray(permissions)) {
                permissions.forEach(perm => {
                    const [mod, action] = perm.split(':');
                    if (!permissionsObj[mod]) permissionsObj[mod] = [];
                    permissionsObj[mod].push(action);
                });
            }
            if (existing.is_system) {
                db.prepare(`
                    UPDATE roles SET display_name = ?, description = ?, permissions = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(display_name.trim(), description || null, JSON.stringify(permissionsObj), roleId);
            } else {
                db.prepare(`
                    UPDATE roles SET role_name = ?, display_name = ?, description = ?, permissions = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(role_name.toLowerCase().trim(), display_name.trim(), description || null, JSON.stringify(permissionsObj), roleId);
            }
            logActivity(req, 'update', `編輯角色：${display_name}`, 'role', roleId);
            flash(req, 'success', '角色更新成功！');
            res.redirect('/roles');
        } catch (error) {
            logger.error('編輯角色錯誤:', error);
            flash(req, 'error', error.message.includes('UNIQUE') ? '角色名稱已存在' : '編輯角色失敗');
            res.redirect(`/roles/edit/${roleId}`);
        }
    });

    app.post('/roles/delete/:id', requireAdmin, (req, res) => {
        const roleId = req.params.id;
        try {
            const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
            if (!role) {
                flash(req, 'error', '角色不存在');
                return res.redirect('/roles');
            }
            if (role.is_system) {
                flash(req, 'error', '系統角色不能刪除');
                return res.redirect('/roles');
            }
            const userCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get(role.role_name);
            if (userCount && userCount.count > 0) {
                flash(req, 'error', `無法刪除：仍有 ${userCount.count} 個使用者使用此角色`);
                return res.redirect('/roles');
            }
            db.prepare('DELETE FROM roles WHERE id = ?').run(roleId);
            logActivity(req, 'delete', `刪除角色：${role.display_name}`, 'role', roleId);
            flash(req, 'success', '角色刪除成功！');
            res.redirect('/roles');
        } catch (error) {
            logger.error('刪除角色錯誤:', error);
            flash(req, 'error', '刪除角色失敗');
            res.redirect('/roles');
        }
    });
};
