require('./setup');
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loginAsAdmin } = require('./helper');

const { app, db, ready, closeForTest } = require('../../server');

// DB 用 :memory:（見 setup.js）會自動隔離，但圖片上傳寫入的是真實的 public/uploads/parts/ 目錄
// （非測試專用路徑），所以這裡測試完要自己清掉寫入磁碟的檔案，避免污染開發環境
const writtenFiles = [];
after(() => {
    for (const p of writtenFiles) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    closeForTest();
});

let agent;
before(async () => {
    await ready;
    db.prepare("UPDATE users SET force_password_change = 0 WHERE username = 'admin'").run();
    agent = await loginAsAdmin(app);
});

let seedCounter = 0;
function seedPart() {
    seedCounter += 1;
    const result = db.prepare(`
        INSERT INTO parts (part_number, part_name, specification, unit, min_stock, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
    `).run(`IMG-TEST-${String(seedCounter).padStart(3, '0')}`, '測試料件（圖片）', '規格', '個', 0);
    return result.lastInsertRowid;
}

async function makeTestPng(size = 50) {
    return sharp({ create: { width: size, height: size, channels: 3, background: { r: 200, g: 50, b: 50 } } })
        .png()
        .toBuffer();
}

test('上傳料件圖片：轉成 WebP、限縮尺寸、寫入磁碟', async () => {
    const partId = seedPart();
    const pngBuffer = await makeTestPng(3000); // 超過 2000px 上限，驗證有被縮小

    const res = await agent
        .post(`/parts/${partId}/upload-image`)
        .set('Origin', 'http://localhost')
        .attach('part_image', pngBuffer, { filename: 'test.png', contentType: 'image/png' });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.match(res.body.image_path, /\/uploads\/parts\/part_\d+_[0-9a-f]+\.webp$/);

    const diskPath = path.join(__dirname, '..', '..', 'public', res.body.image_path);
    writtenFiles.push(diskPath);
    assert.ok(fs.existsSync(diskPath), '轉檔後的檔案應該存在於磁碟');

    const meta = await sharp(diskPath).metadata();
    assert.equal(meta.format, 'webp');
    assert.ok(meta.width <= 2000 && meta.height <= 2000, '長邊應該被限制在 2000px 內');

    const part = db.prepare('SELECT image_path FROM parts WHERE id = ?').get(partId);
    assert.equal(part.image_path, res.body.image_path);
});

test('上傳新圖片會刪除舊圖片檔案', async () => {
    const partId = seedPart();
    const first = await agent
        .post(`/parts/${partId}/upload-image`)
        .set('Origin', 'http://localhost')
        .attach('part_image', await makeTestPng(), { filename: 'a.png', contentType: 'image/png' });
    const firstDiskPath = path.join(__dirname, '..', '..', 'public', first.body.image_path);
    assert.ok(fs.existsSync(firstDiskPath));

    const second = await agent
        .post(`/parts/${partId}/upload-image`)
        .set('Origin', 'http://localhost')
        .attach('part_image', await makeTestPng(), { filename: 'b.png', contentType: 'image/png' });

    assert.equal(second.body.success, true);
    assert.notEqual(second.body.image_path, first.body.image_path);
    assert.ok(!fs.existsSync(firstDiskPath), '舊圖片檔案應該被刪除');
    writtenFiles.push(path.join(__dirname, '..', '..', 'public', second.body.image_path));
});

test('毀損的圖片檔案：回傳看得懂的錯誤而非 500', async () => {
    const partId = seedPart();
    const garbage = Buffer.from('this is not a real image file, just text pretending to be png');

    const res = await agent
        .post(`/parts/${partId}/upload-image`)
        .set('Origin', 'http://localhost')
        .attach('part_image', garbage, { filename: 'broken.png', contentType: 'image/png' });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /圖片檔案無法處理/);
});

test('HEIC/HEIF 格式：擋下並給出可操作的中文提示', async () => {
    const partId = seedPart();
    const res = await agent
        .post(`/parts/${partId}/upload-image`)
        .set('Origin', 'http://localhost')
        .attach('part_image', Buffer.from('fake heic bytes'), { filename: 'photo.heic', contentType: 'image/heic' });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /HEIC\/HEIF/);
});

test('不存在的料件 ID：回傳錯誤而非寫入孤兒檔案', async () => {
    const res = await agent
        .post('/parts/999999/upload-image')
        .set('Origin', 'http://localhost')
        .attach('part_image', await makeTestPng(), { filename: 'x.png', contentType: 'image/png' });

    assert.equal(res.body.success, false);
    assert.match(res.body.error, /不存在/);
});
