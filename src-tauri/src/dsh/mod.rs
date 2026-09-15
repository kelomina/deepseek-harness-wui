use tauri::Manager;

pub mod browser_auth;
pub mod config;
pub mod event;
pub mod manager;
pub mod plugin_host;
pub mod plugins;
pub mod prereq;
pub mod proxy;
pub mod pty;
pub mod routing_suite;
pub mod runtime;
pub mod wsl;
#[cfg(feature = "e2e")]
pub mod e2e_wsl;

/// 打包资源根候选（含 NSIS 的 `_up_` 落盘形态）。
///
/// `bundle.resources` 里 `../plugins/…`、`../plugin-host/**` 这类越出 `src-tauri`
/// 的资源键，NSIS 会装到 `$INSTDIR/_up_/…`（`_up_` = 上跳一级；0.4.1 安装包实测），
/// 而 `path().resolve(rel, Resource)` 只会拼 `$INSTDIR/<rel>` → 安装包内永远找不到
/// 自带资源。所有资源定位都必须走这里，别各自猜一个路径。
pub fn resource_roots(app: &tauri::AppHandle) -> Vec<std::path::PathBuf> {
    let mut base: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        base.push(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            base.push(dir.to_path_buf());
        }
    }
    expand_resource_roots(base)
}

/// 纯函数部分：为每个根补一个 `<root>/_up_` 候选，保持顺序并去重。
pub(crate) fn expand_resource_roots(roots: Vec<std::path::PathBuf>) -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    for root in roots {
        for cand in [root.clone(), root.join("_up_")] {
            if !out.contains(&cand) {
                out.push(cand);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::expand_resource_roots;
    use std::path::PathBuf;

    #[test]
    fn resource_roots_add_up_one_and_dedupe() {
        let roots = expand_resource_roots(vec![
            PathBuf::from("/inst"),
            PathBuf::from("/inst"),
            PathBuf::from("/other"),
        ]);
        assert_eq!(
            roots,
            vec![
                PathBuf::from("/inst"),
                PathBuf::from("/inst/_up_"),
                PathBuf::from("/other"),
                PathBuf::from("/other/_up_"),
            ]
        );
        assert!(expand_resource_roots(vec![]).is_empty());
    }
}
