// 料件類型管理
const validators = require('../lib/validators');

module.exports = function mountCategoryRoutes(ctx) {
    const { app, db, config, flash, logActivity } = ctx;
    const PAGE_TITLE = config.PAGE_TITLE;

    app.get('/categories', (req, res) => {
        const categories = db.prepare(`
            SELECT id, name, description, datetime(created_at, '+8 hours') as created_at
            FROM categories ORDER BY name
        `).all();
        logActivity(req, 'view', '查看料件類型列表', 'categories', null);
        res.render('categories_list', { categories, title: PAGE_TITLE });
    });

    app.get('/categories/add', (req, res) => {
        res.render('add_category', { title: PAGE_TITLE });
    });

    app.post('/categories/add', (req, res) => {
        const { name, description } = req.body;
        const v = validators.check([
            ['name', validators.rules.displayName(name, { label: '類型名稱', max: 100 })],
            ['description', validators.rules.freeText(description, { label: '說明', max: 500 })]
        ]);
        if (!v.ok) {
            flash(req, 'error', v.errors[0].message);
            return res.redirect('/categories/add');
        }
        try {
            const result = db.prepare('INSERT INTO categories (name, description) VALUES (?, ?)')
                .run(name.trim(), description ? description.trim() : null);
            logActivity(req, 'create', `新增料件類型：${name}`, 'category', result.lastInsertRowid);
            flash(req, 'success', '類型新增成功！');
            res.redirect('/categories');
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') flash(req, 'error', '類型名稱已存在！');
            else flash(req, 'error', `新增失敗：${error.message}`);
            res.redirect('/categories/add');
        }
    });

    app.get('/categories/edit/:id', (req, res) => {
        const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
        if (!category) {
            flash(req, 'error', '類型不存在！');
            return res.redirect('/categories');
        }
        res.render('edit_category', { category, title: PAGE_TITLE });
    });

    app.post('/categories/edit/:id', (req, res) => {
        const { id } = req.params;
        const { name, description } = req.body;
        const v = validators.check([
            ['id', validators.rules.positiveInt(id)],
            ['name', validators.rules.displayName(name, { label: '類型名稱', max: 100 })],
            ['description', validators.rules.freeText(description, { label: '說明', max: 500 })]
        ]);
        if (!v.ok) {
            flash(req, 'error', v.errors[0].message);
            return res.redirect(`/categories/edit/${id}`);
        }
        try {
            db.prepare('UPDATE categories SET name = ?, description = ? WHERE id = ?')
                .run(name.trim(), description ? description.trim() : null, id);
            logActivity(req, 'update', `編輯料件類型：${name}`, 'category', parseInt(id));
            flash(req, 'success', '類型更新成功！');
            res.redirect('/categories');
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') flash(req, 'error', '類型名稱已存在！');
            else flash(req, 'error', `更新失敗：${error.message}`);
            res.redirect(`/categories/edit/${id}`);
        }
    });

    app.post('/categories/delete/:id', (req, res) => {
        const { id } = req.params;
        try {
            const inUse = db.prepare('SELECT COUNT(*) as count FROM parts WHERE category_id = ?').get(id);
            if (inUse.count > 0) {
                flash(req, 'error', `無法刪除：仍有 ${inUse.count} 個料件使用此類型！`);
                return res.redirect('/categories');
            }
            const category = db.prepare('SELECT name FROM categories WHERE id = ?').get(id);
            const categoryName = category ? category.name : '未知';
            db.prepare('DELETE FROM categories WHERE id = ?').run(id);
            logActivity(req, 'delete', `刪除料件類型：${categoryName}`, 'category', parseInt(id));
            flash(req, 'success', '類型刪除成功！');
            res.redirect('/categories');
        } catch (error) {
            flash(req, 'error', `刪除失敗：${error.message}`);
            res.redirect('/categories');
        }
    });
};
