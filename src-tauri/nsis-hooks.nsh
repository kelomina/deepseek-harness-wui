; Tauri NSIS 安装钩子（bundle.windows.nsis.installerHooks）。
; 安装期检测 Node.js：官方安装器写注册表 SOFTWARE\Node.js；缺失时提示将由应用首启引导自动安装。
; 说明：Node 的 MSI 静默安装需要管理员权限，而本安装器默认按当前用户安装（不提权），
; 因此不在安装器内静默装 Node——由应用首启向导经 UAC 授权完成（跨平台行为一致）。

!macro NSIS_HOOK_POSTINSTALL
  ClearErrors
  ReadRegStr $R0 HKLM "SOFTWARE\Node.js" "InstallPath"
  IfErrors 0 nodeFound
  ReadRegStr $R0 HKCU "SOFTWARE\Node.js" "InstallPath"
  IfErrors 0 nodeFound
  MessageBox MB_OK|MB_ICONINFORMATION "未检测到 Node.js。$\n$\n首次启动应用时会自动引导安装（下载官方 v22.19.0 并校验 SHA256，需要网络与授权确认）。"
  Goto nodeDone
nodeFound:
nodeDone:
!macroend
