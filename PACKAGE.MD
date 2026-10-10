# 打包版本号变更。

## 1. 先把当前已暂存的变更提交掉（version 命令要求工作区干净）
git commit -m "feat: ..."

## 2. 升版本号（三选一）
pnpm version patch   # 1.0.0 → 1.0.1  修 bug、小调整
pnpm version minor   # 1.0.0 → 1.1.0  新功能
pnpm version major   # 1.0.0 → 2.0.0  破坏性变更

## 也可以直接指定版本号
pnpm version 1.2.0

## 3. 推送（version 命令会自动创建 v1.1.0 的 commit 和 tag）
git push --follow-tags

## 4. 打包，产物自动带新版本号
pnpm run dist:win
