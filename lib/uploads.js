// 檔案上傳設定（Excel 匯入、料件圖片）
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');

function safeExtension(originalName, allowedExts) {
    const ext = path.extname(originalName || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
    if (allowedExts && allowedExts.length && !allowedExts.includes(ext)) return allowedExts[0];
    return ext || '.bin';
}

// 圖片轉檔失敗（檔案毀損、或 sharp/libvips 無法解碼的變體格式）要回一個使用者看得懂的訊息，
// 不能讓例外原始訊息一路穿到最外層變成「伺服器發生錯誤」
class UnsupportedImageError extends Error {}

const IMAGE_MAX_DIMENSION = 2000;
const IMAGE_WEBP_QUALITY = 82;

// 料件圖片一律轉成 WebP 並限制長邊尺寸：手機拍照動輒 4000px 以上、好幾 MB，料件照片只要看得清楚即可，
// 轉檔 + 限制尺寸能把檔案壓到原本的 20~40%；同時用 EXIF 方向自動轉正，避免手機直拍存起來變橫的
async function processPartImage(buffer) {
    try {
        return await sharp(buffer)
            .rotate()
            .resize({ width: IMAGE_MAX_DIMENSION, height: IMAGE_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: IMAGE_WEBP_QUALITY })
            .toBuffer();
    } catch (err) {
        throw new UnsupportedImageError('圖片檔案無法處理，請確認檔案沒有毀損，或改用 JPG / PNG 格式重新上傳');
    }
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

    // 料件圖片：記憶體暫存，交給 processPartImage 用 Sharp 轉檔後才寫入磁碟（見下方路由層）
    const ALLOWED_IMG_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const HEIC_MIMES = ['image/heic', 'image/heif'];
    const uploadPartImage = multer({
        storage: multer.memoryStorage(),
        fileFilter: (req, file, cb) => {
            if (HEIC_MIMES.includes(file.mimetype)) {
                return cb(new UnsupportedImageError(
                    '不支援 HEIC/HEIF 格式（iPhone 拍照預設格式）。請到手機「設定 → 相機 → 格式」改成「最相容」，' +
                    '或改用「檔案」App 把照片轉存成 JPEG 後再上傳'
                ));
            }
            if (!ALLOWED_IMG_MIMES.includes(file.mimetype)) {
                return cb(new Error('只允許上傳圖片（jpg/png/webp/gif）'));
            }
            cb(null, true);
        },
        limits: { fileSize: config.UPLOAD_IMAGE_MAX_BYTES }
    });

    return { upload, uploadPartImage, UPLOAD_DIR, PART_IMG_DIR, safeExtension, processPartImage, UnsupportedImageError };
};
