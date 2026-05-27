// 單位管理
const validators = require('../lib/validators');

module.exports = function mountUnitRoutes(ctx) {
    const { app, db, config, flash, logActivity } = ctx;
    const PAGE_TITLE = config.PAGE_TITLE;

    app.get('/units', (req, res) => {
        const units = db.prepare(`
            SELECT id, name, symbol, description, datetime(created_at, '+8 hours') as created_at
            FROM units ORDER BY name
        `).all();
        logActivity(req, 'view', '查看單位列表', 'units', null);
        res.render('units_list', { units, title: PAGE_TITLE });
    });

    app.get('/units/add', (req, res) => {
        res.render('add_unit', { title: PAGE_TITLE });
    });

    app.post('/units/add', (req, res) => {
        const { name, symbol, description } = req.body;
        const v = validators.check([
            ['name', validators.rules.displayName(name, { label: '單位名稱', max: 50 })],
            ['symbol', validators.rules.freeText(symbol, { label: '符號', max: 20 })],
            ['description', validators.rules.freeText(description, { label: '說明', max: 500 })]
        ]);
        if (!v.ok) {
            flash(req, 'error', v.errors[0].message);
            return res.redirect('/units/add');
        }
        try {
            const result = db.prepare('INSERT INTO units (name, symbol, description) VALUES (?, ?, ?)')
                .run(name.trim(), (symbol || name).trim(), description ? description.trim() : null);
            logActivity(req, 'create', `新增單位：${name}`, 'unit', result.lastInsertRowid);
            flash(req, 'success', '單位新增成功！');
            res.redirect('/units');
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') flash(req, 'error', '單位名稱已存在！');
            else flash(req, 'error', `新增失敗：${error.message}`);
            res.redirect('/units/add');
        }
    });

    app.get('/units/edit/:id', (req, res) => {
        const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id);
        if (!unit) {
            flash(req, 'error', '單位不存在！');
            return res.redirect('/units');
        }
        res.render('edit_unit', { unit, title: PAGE_TITLE });
    });

    app.post('/units/edit/:id', (req, res) => {
        const { id } = req.params;
        const { name, symbol, description } = req.body;
        const v = validators.check([
            ['id', validators.rules.positiveInt(id)],
            ['name', validators.rules.displayName(name, { label: '單位名稱', max: 50 })],
            ['symbol', validators.rules.freeText(symbol, { label: '符號', max: 20 })],
            ['description', validators.rules.freeText(description, { label: '說明', max: 500 })]
        ]);
        if (!v.ok) {
            flash(req, 'error', v.errors[0].message);
            return res.redirect(`/units/edit/${id}`);
        }
        try {
            db.prepare('UPDATE units SET name = ?, symbol = ?, description = ? WHERE id = ?')
                .run(name.trim(), (symbol || name).trim(), description ? description.trim() : null, id);
            logActivity(req, 'update', `編輯單位：${name}`, 'unit', parseInt(id));
            flash(req, 'success', '單位更新成功！');
            res.redirect('/units');
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') flash(req, 'error', '單位名稱已存在！');
            else flash(req, 'error', `更新失敗：${error.message}`);
            res.redirect(`/units/edit/${id}`);
        }
    });

    app.post('/units/delete/:id', (req, res) => {
        const { id } = req.params;
        try {
            const inUse = db.prepare(
                'SELECT COUNT(*) as count FROM parts WHERE unit = (SELECT name FROM units WHERE id = ?)'
            ).get(id);
            if (inUse.count > 0) {
                flash(req, 'error', `無法刪除：仍有 ${inUse.count} 個料件使用此單位！`);
                return res.redirect('/units');
            }
            const unit = db.prepare('SELECT name FROM units WHERE id = ?').get(id);
            const unitName = unit ? unit.name : '未知';
            db.prepare('DELETE FROM units WHERE id = ?').run(id);
            logActivity(req, 'delete', `刪除單位：${unitName}`, 'unit', parseInt(id));
            flash(req, 'success', '單位刪除成功！');
            res.redirect('/units');
        } catch (error) {
            flash(req, 'error', `刪除失敗：${error.message}`);
            res.redirect('/units');
        }
    });
};
