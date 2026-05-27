// 檔案上傳設定（Excel 匯入、料件圖片）
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

function safeExtension(originalName, allowedExts) {
    const ext = path.extname(originalName || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
    if (allowedExts && allowedExts.length && !allowedExts.includes(ext)) return allowedExts[0];
    return ext || '.bin';
}

module.exports = function createUploads({ baseDir, config }) {
    const UPLOAD_DIR = path.join(baseDir, 'uploads');
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    const PART_IMG_DIR = path.join(baseDir, 'public', 'uploads', 'parts');
    if (!fs.existsSync(PART_IMG_DIR)) fs.mkdirSync(PART_IMG_DIR, { recursive: true });

    // Excel 匯入（隨機檔名）
    const upload = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => cb(null, UPLOAD_DIR),
            filename: (req, file, cb) => {
                const ext = safeExtension(file.originalname, ['.xlsx', '.xls', '.csv']);
                cb(null, `import_${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
            }
        }),
        fileFilter: (req, file, cb) => {
            const allowedMimes = [
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/vnd.ms-excel',
                'text/csv'
            ];
            if (allowedMimes.includes(file.mimetype)) cb(null, true);
            else cb(new Error('只允許上傳 Excel 檔案 (.xlsx, .xls)'));
        },
        limits: { fileSize: config.UPLOAD_EXCEL_MAX_BYTES }
    });

    // 料件圖片（UUID + 白名單副檔名）
    const ALLOWED_IMG_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const uploadPartImage = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => cb(null, PART_IMG_DIR),
            filename: (req, file, cb) => {
                const partId = parseInt(req.params.id);
                if (!Number.isInteger(partId) || partId <= 0) return cb(new Error('無效的料件 ID'));
                const ext = safeExtension(file.originalname, ALLOWED_IMG_EXTS);
                const rand = crypto.randomBytes(6).toString('hex');
                cb(null, `part_${partId}_${rand}${ext}`);
            }
        }),
        fileFilter: (req, file, cb) => {
            const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
            if (allowed.includes(file.mimetype)) cb(null, true);
            else cb(new Error('只允許上傳圖片（jpg/png/webp/gif）'));
        },
        limits: { fileSize: config.UPLOAD_IMAGE_MAX_BYTES }
    });

    return { upload, uploadPartImage, UPLOAD_DIR, PART_IMG_DIR, safeExtension };
};
