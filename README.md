# 庫存管理系統 (Node.js 版本)

一套完整的料件庫存管理系統，使用 Node.js + Express + SQLite 開發，支援桌面版與手機版。

## 功能特色

### 📦 料件管理
- ✅ 料件資料管理（新增、編輯、啟用/停用）
- ✅ 條碼掃描支援（相機掃描 + 無線掃描器）
- ✅ 類型分類與篩選
- ✅ 分頁、排序、搜尋
- ✅ 統計摘要卡片（總數、啟用、停用、零庫存）
- ✅ 目前庫存量即時顯示
- ✅ **最低庫存警示（安全庫存量設定）**
- ✅ 快速查看 Modal（近期出入庫記錄）
- ✅ 批量刪除（依角色權限）

### 📥📤 出入庫
- ✅ 料件入庫記錄
- ✅ 料件出庫記錄
- ✅ 借測管理（借出 / 歸還 / 轉出貨）
- ✅ **選料件時即時顯示目前庫存量**
- ✅ 發票號碼記錄
- ✅ 出入庫記錄查詢與 Excel 匯出

### 📊 庫存儀表板（首頁）
- ✅ 統計卡片（總料件、總庫存、借出中、可用）
- ✅ **低庫存警示面板**（低於最低庫存量的料件）
- ✅ **近期 10 筆出入庫記錄**
- ✅ **可點擊列（點擊跳轉到料件管理）**
- ✅ 借測到期通知
- ✅ 手機版儀表板 / 列表切換

### 🔍 盤點功能
- ✅ 庫存盤點（建立盤點事件、逐件核對）
- ✅ 盤點差異報表

### 👥 系統管理
- ✅ 人員管理
- ✅ 角色管理（細粒度權限控制）
- ✅ 操作紀錄（CST 時間顯示）
- ✅ 自動備份排程
- ✅ Excel 匯入料件
- ✅ 系統健康監測

## 🚀 快速部署（推薦）

### 一鍵自動部署

在專案目錄中執行以下指令即可完成所有設置：

```bash
chmod +x deploy.sh
./deploy.sh
```

部署腳本會自動完成：
- ✅ 檢查並安裝 Node.js
- ✅ 安裝專案依賴
- ✅ 設定防火牆（可選）
- ✅ 建立 systemd 服務（可選）
- ✅ 啟動系統

## 📋 手動安裝說明

如果您想手動安裝，請按照以下步驟：

### 1. 安裝 Node.js
確保您的 Ubuntu 系統已安裝 Node.js 14 或更高版本。

```bash
# 檢查是否已安裝
node --version
npm --version

# 如果未安裝，執行以下指令
sudo apt update
sudo apt install nodejs npm -y
```

### 2. 安裝專案依賴套件
在專案目錄中執行：

```bash
npm install
```

### 3. 啟動系統

```bash
npm start
```

系統啟動後，您會看到：
```
🚀 庫存管理系統已啟動！
📡 請訪問：http://localhost:5000
🌐 區域網路訪問：http://[您的IP]:5000
```

開啟瀏覽器並訪問：

```
http://localhost:5000
```

## 🛠️ 管理腳本

系統提供了多個管理腳本，讓您輕鬆管理系統：

### 快速啟動
```bash
chmod +x quick-start.sh
./quick-start.sh
```

### 停止系統
```bash
chmod +x stop.sh
./stop.sh
```

### 查看狀態
```bash
chmod +x status.sh
./status.sh
```

### 更新系統
```bash
chmod +x update.sh
./update.sh
```

### 卸載系統
```bash
chmod +x uninstall.sh
./uninstall.sh
```

## 開發模式（可選）

如果您想要在開發時自動重啟伺服器，可以使用：

```bash
npm run dev
```

## 使用說明

### 1. 新增料件
- 點擊「料件管理」→「新增料件」
- 填寫料號、料件名稱、規格、單位
- 點擊「新增料件」

### 2. 料件入庫
- 點擊「料件入庫」
- 選擇料件、輸入數量、選擇日期
- 可選填備註
- 點擊「確認入庫」

### 3. 查詢庫存
- 點擊「庫存查詢」
- 即可看到所有料件的當前庫存數量

### 4. 查看入庫記錄
- 點擊「入庫記錄」
- 可查看最近 100 筆入庫記錄

## 資料庫

系統使用 SQLite 資料庫，檔案名稱為 `database.db`，會自動在首次啟動時建立。支援自動 schema 遷移（新欄位會自動 ALTER TABLE，不影響現有資料）。

### 主要資料表

| 資料表 | 說明 |
|--------|------|
| `parts` | 料件主檔（含 `min_stock` 最低庫存、`is_active` 啟用狀態） |
| `inbound_records` | 入庫 / 歸還記錄 |
| `outbound_records` | 出庫 / 借測記錄（含 `has_invoice`、`converted_from_loan`） |
| `categories` | 料件類型 |
| `units` | 計量單位 |
| `users` | 系統使用者 |
| `roles` | 角色與細粒度權限 |
| `activity_logs` | 操作紀錄（時間儲存 UTC，查詢時轉 CST） |

## 技術架構

- **後端框架**：Express 4.x
- **模板引擎**：EJS
- **資料庫**：SQLite（better-sqlite3），自動 schema 遷移
- **前端**：HTML + CSS（設計系統 v3.0）+ Vanilla JS
- **響應式設計**：桌面固定側邊欄 + 手機底部導航 + 手機滑出抽屜
- **UI/UX**：設計系統（CSS 變數）、統一配色（Indigo + 深藍灰側邊欄）
- **權限系統**：細粒度角色權限（session 層 + 路由層雙重驗證）
- **條碼支援**：ZXing 相機掃描 + USB/藍芽無線掃描器
- **共用組件**：`_common-nav.ejs`（導航）/ `_common-styles.ejs`（設計系統）/ `_common-nav-script.ejs`（互動邏輯）

## 📱 響應式設計特色

### 桌面版（> 768px）
- ✅ **固定左側側邊欄**（250px 寬），含分組導航（主要功能、記錄查詢、系統管理、系統工具）
- ✅ 側邊欄底部顯示使用者資訊、修改密碼、登出
- ✅ 當前頁面導航連結自動高亮（最長路徑優先算法）
- ✅ 完整表格顯示，統一淺灰色表頭
- ✅ 統一設計系統（Indigo 主色調 + 深藍灰側邊欄）

### 手機版（≤ 768px）
- ✅ **頂部固定工具列**：顯示 App 名稱 + 漢堡按鈕
- ✅ **底部導航列**：庫存 / 料件 / 入庫 / 出庫 / 更多 五個常用功能
- ✅ **點「更多」滑出完整側邊欄**，可瀏覽所有功能選單
- ✅ 頁面內容固定在頂部列與底部列之間，不重疊（`position: fixed` 容器）
- ✅ 表格橫向滾動查看，觸控流暢（`-webkit-overflow-scrolling: touch`）
- ✅ iOS Safari 相容（使用固定定位容器而非依賴 body padding）

詳細技術資訊請參閱 [技術文件](TECHNICAL_NOTES.md)

## 專案結構

```
庫存管理系統/
├── server.js              # Node.js 主程式
├── package.json           # 套件設定檔
├── README.md             # 說明文件
├── .gitignore            # Git 忽略檔案
├── deploy.sh             # 🚀 一鍵部署腳本
├── quick-start.sh        # 快速啟動腳本
├── stop.sh               # 停止系統腳本
├── status.sh             # 狀態查詢腳本
├── update.sh             # 更新系統腳本
├── uninstall.sh          # 卸載系統腳本
├── views/                    # EJS 模板目錄
│   ├── _common-styles.ejs   # 設計系統 v3.0（CSS 變數 + 響應式佈局）
│   ├── _common-nav.ejs      # 共用導航組件（側邊欄 + 手機頂部列 + 底部導航）
│   ├── _common-nav-script.ejs # 側邊欄互動腳本
│   ├── index.ejs            # 庫存查詢儀表板
│   ├── parts_list.ejs       # 料件管理（統計卡片 + 分頁 + 快速查看）
│   ├── inbound.ejs          # 料件入庫
│   ├── outbound.ejs         # 料件出庫
│   └── ...（30+ 頁面）
└── inventory.db          # SQLite 資料庫（自動生成）
```

## 停止系統

在終端機中按 `Ctrl + C` 即可停止系統。

## 背景執行（可選）

如果您想讓系統在背景執行：

```bash
# 使用 nohup
nohup npm start > output.log 2>&1 &

# 查看執行狀態
ps aux | grep node

# 停止背景程序
kill <PID>
```

## 設定開機自動啟動（可選）

建立 systemd 服務檔案：

```bash
sudo nano /etc/systemd/system/inventory.service
```

內容如下：

```ini
[Unit]
Description=Inventory Management System
After=network.target

[Service]
Type=simple
User=你的使用者名稱
WorkingDirectory=/path/to/庫存管理系統
ExecStart=/usr/bin/npm start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

啟用服務：

```bash
sudo systemctl enable inventory.service
sudo systemctl start inventory.service
sudo systemctl status inventory.service
```

## 注意事項

- 此為最簡單版本，適合單人或小團隊使用
- 資料庫檔案 `inventory.db` 請妥善備份
- 料號不可重複
- 預設在本機 5000 埠運行
- 系統可在區域網路內訪問

## 疑難排解

### 無法啟動系統

1. 檢查 Node.js 版本：`node --version`（需要 14 以上）
2. 重新安裝依賴：`rm -rf node_modules && npm install`
3. 檢查埠號是否被佔用：`lsof -i :5000`

### 無法連接資料庫

確保有寫入權限：`chmod 755 .`

## 授權

此專案為個人使用，無特定授權限制。
