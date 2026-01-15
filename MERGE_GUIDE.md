# 分支合併到 MAIN 指南

## 當前分支狀態

✅ **已規範化的分支**：
- `remove/backup-opt-folder` - 移除備份管理頁面的 /opt 資料夾管理功能
- `feature/force-logout-setting` - 新增強制登出時間設定功能

## 合併到 MAIN 的方法

### 方法一：使用 Pull Request（推薦）⭐

這是最安全和推薦的方式，因為可以在 GitHub 上進行代碼審查。

#### 步驟 1：在 GitHub 上創建 Pull Request

1. 訪問 GitHub 倉庫：https://github.com/oupaul/inv
2. 點擊 "Pull requests" 標籤
3. 點擊 "New pull request"
4. 選擇要合併的分支：
   - **Base**: `main` ← 要合併到的目標分支
   - **Compare**: `remove/backup-opt-folder` 或 `feature/force-logout-setting` ← 要合併的分支
5. 填寫 PR 標題和描述
6. 點擊 "Create pull request"

#### 步驟 2：審查和合併

1. 在 PR 頁面上檢查變更
2. 確認沒有衝突
3. 點擊 "Merge pull request"
4. 選擇合併方式：
   - **Create a merge commit**（推薦）：保留完整歷史記錄
   - **Squash and merge**：將多個提交合併成一個
   - **Rebase and merge**：線性歷史，但會重寫提交記錄
5. 確認合併

#### 步驟 3：清理本地分支

```bash
# 切換到 main 分支
git checkout main

# 更新本地 main 分支
git pull origin main

# 刪除已合併的本地分支
git branch -d remove/backup-opt-folder
git branch -d feature/force-logout-setting
```

---

### 方法二：本地合併後推送

如果需要快速合併且不需要審查，可以使用此方法。

#### ⚠️ 注意事項
- 確保代碼已經測試過
- 確保沒有其他人在使用這些分支
- 建議在合併前先備份

#### 步驟 1：更新 main 分支

```bash
# 切換到 main 分支
git checkout main

# 拉取最新的 main 分支
git pull origin main
```

#### 步驟 2：合併功能分支

```bash
# 合併第一個功能分支
git merge remove/backup-opt-folder -m "合併：移除備份管理頁面的 /opt 資料夾管理功能"

# 如果有衝突，解決衝突後：
# git add .
# git commit

# 合併第二個功能分支
git merge feature/force-logout-setting -m "合併：新增強制登出時間設定功能"
```

#### 步驟 3：推送到 GitHub

```bash
git push origin main
```

#### 步驟 4：清理分支

```bash
# 刪除本地分支
git branch -d remove/backup-opt-folder
git branch -d feature/force-logout-setting

# 刪除遠程分支
git push origin --delete remove/backup-opt-folder
git push origin --delete feature/force-logout-setting
```

---

## 解決合併衝突

如果合併時出現衝突：

### 1. 查看衝突文件
```bash
git status
```

### 2. 編輯衝突文件
打開有衝突的文件，找到衝突標記：
```
<<<<<<< HEAD
main 分支的代碼
=======
功能分支的代碼
>>>>>>> feature/force-logout-setting
```

### 3. 解決衝突
- 保留需要的代碼
- 刪除衝突標記
- 確保代碼邏輯正確

### 4. 標記為已解決
```bash
git add <衝突的文件>
git commit -m "解決合併衝突"
```

---

## 合併順序建議

### 如果兩個功能相互獨立
可以按任意順序合併，或同時合併：

1. **方案 A**：先合併 `remove/backup-opt-folder`，再合併 `feature/force-logout-setting`
2. **方案 B**：同時創建兩個 PR，分別審查後合併

### 如果功能有依賴關係
先合併被依賴的功能，再合併依賴的功能。

---

## 版本標籤建議

合併完成後，建議打上版本標籤：

```bash
# 切換到 main 分支
git checkout main
git pull origin main

# 打標籤
git tag -a v1.1.0 -m "版本 1.1.0
- 移除備份管理頁面的 /opt 資料夾管理功能
- 新增強制登出時間設定功能"

# 推送標籤
git push origin v1.1.0
```

---

## 最佳實踐檢查清單

合併前請確認：
- [ ] 代碼已經測試過，可以正常運行
- [ ] 沒有語法錯誤或 lint 錯誤
- [ ] 提交訊息清晰明確
- [ ] 已經備份重要數據（如果需要）
- [ ] 通知團隊成員（如果有的話）
- [ ] 檢查是否有未提交的更改

---

## 快速參考命令

```bash
# 查看所有分支
git branch -a

# 查看分支狀態
git status

# 切換分支
git checkout <分支名稱>

# 更新分支
git pull origin <分支名稱>

# 合併分支
git merge <分支名稱>

# 刪除本地分支
git branch -d <分支名稱>

# 刪除遠程分支
git push origin --delete <分支名稱>
```
