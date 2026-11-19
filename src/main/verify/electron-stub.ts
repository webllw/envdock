/** 验证脚本用的 electron 桩，paths.ts 只在未打包分支使用 app.getAppPath */
export const app = {
  isPackaged: false,
  getAppPath: () => process.cwd()
}
