//! Plugin management bridge: reads the dsh profile's effective plugin
//! configuration (via `dsh web --dump-config`), toggles enable/disable in the
//! profile's `cordis.patch.yml` (the documented user patch layer), and
//! forwards import/delete to `dsh plugin add/remove` (pnpm-backed).
//!
//! The current dsh browser API (apiproxy) does NOT expose plugin
//! enable/disable/import/delete RPCs, so these commands run the bundled dsh CLI
//! on the Rust side (same DSH_HOME the manager launches dsh with).

use crate::dsh::config::DshConfig;
use crate::dsh::manager::bundled_bin_path;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct PluginEntry {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// Heuristic: entries whose module name is under `@deepseek-ai/` are treated as dsh 内置插件.
    pub builtin: bool,
    /// `disabled: !!js ...` 条件禁用（平台相关），由 loader 求值；不提供手动开关。
    pub conditional: bool,
}

/// Resolve the harness home used by the managed dsh process.
pub fn dsh_home(cfg: &DshConfig) -> PathBuf {
    if let Some(h) = &cfg.dsh_home {
        if !h.trim().is_empty() {
            return PathBuf::from(h);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".dsh")
}

/// Run `node <dsh-cli> <args>` with the given DSH_HOME; returns combined output.
pub(crate) fn run_dsh_cli(args: &[&str], home: &Path) -> Result<String, String> {
    let bin = bundled_bin_path()?;
    let mut cmd = Command::new("node");
    cmd.arg(&bin).args(args).env("DSH_HOME", home);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| format!("无法启动 dsh CLI: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "dsh CLI 退出码 {}: {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Parse `dsh web --dump-config` output (a YAML list of `- id:` / `name:` / `disabled:` rows).
fn parse_dump_config(text: &str) -> Vec<PluginEntry> {
    let mut out: Vec<PluginEntry> = Vec::new();
    let mut cur: Option<PluginEntry> = None;
    for line in text.lines() {
        let t = line.trim_end();
        if let Some(rest) = t.strip_prefix("- id: ") {
            if let Some(prev) = cur.take() {
                out.push(prev);
            }
            cur = Some(PluginEntry {
                id: rest.trim().to_string(),
                name: String::new(),
                enabled: true,
                builtin: false,
                conditional: false,
            });
        } else if let Some(rest) = t.strip_prefix("  name: ") {
            if let Some(e) = cur.as_mut() {
                let n = rest.trim().trim_matches('\'');
                e.name = n.to_string();
                e.builtin = n.starts_with("@deepseek-ai/");
            }
        } else if let Some(rest) = t.strip_prefix("  disabled: ") {
            if let Some(e) = cur.as_mut() {
                let v = rest.trim();
                if v.starts_with("!!js") {
                    // 条件禁用：loader 按平台求值，仅标记，不当作固定状态
                    e.conditional = true;
                } else {
                    e.enabled = !v.eq_ignore_ascii_case("true");
                }
            }
        }
    }
    if let Some(prev) = cur {
        out.push(prev);
    }
    out
}

/// List effective plugins from the composed profile config.
pub fn plugins_list(cfg: &DshConfig) -> Result<Vec<PluginEntry>, String> {
    let home = dsh_home(cfg);
    let out = run_dsh_cli(&["web", "--dump-config"], &home)?;
    Ok(parse_dump_config(&out))
}

fn patch_path(home: &Path) -> PathBuf {
    home.join("profiles").join("web").join("cordis.patch.yml")
}

/// Conservative toggle of `disabled` for one entry id in `cordis.patch.yml`.
/// Refuses to rewrite files carrying patch syntax this editor does not
/// understand (insert lists, `!!js`, group rows, config overrides).
fn toggle_patch(content: &str, id: &str, enabled: bool) -> Result<String, String> {
    let lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();

    // Empty-list form: file only carries comments + a `[]` line.
    if !lines.iter().any(|l| l.trim_start().starts_with("- id: ")) {
        let idx = lines
            .iter()
            .position(|l| l.trim() == "[]")
            .ok_or_else(|| "cordis.patch.yml 既无条目也不是 []，拒绝自动改写".to_string())?;
        if enabled {
            return Ok(content.to_string());
        }
        let mut out = lines.clone();
        out[idx] = format!("- id: {id}\n  disabled: true");
        return Ok(out.join("\n") + "\n");
    }

    // Block boundaries (`- id:` lines).
    let block_starts: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.trim_start().starts_with("- id: "))
        .map(|(i, _)| i)
        .collect();

    // Validate every block only carries id/name/disabled keys.
    for (bi, &start) in block_starts.iter().enumerate() {
        let end = block_starts.get(bi + 1).copied().unwrap_or(lines.len());
        for l in &lines[start + 1..end] {
            let t = l.trim_start();
            if t.is_empty() || t.starts_with("- ") {
                continue;
            }
            if !(t.starts_with("id:") || t.starts_with("name:") || t.starts_with("disabled:")) {
                return Err(format!(
                    "cordis.patch.yml 含本工具不支持的条目（{t}），请手动编辑后重试"
                ));
            }
        }
    }

    let mut out = lines.clone();
    let target = block_starts
        .iter()
        .enumerate()
        .find(|(_, &s)| out[s].trim_start().trim_start_matches("- id: ").trim() == id)
        .map(|(bi, &s)| (bi, s));

    if let Some((bi, start)) = target {
        let end = block_starts.get(bi + 1).copied().unwrap_or(out.len());
        if enabled {
            // Enable: drop the `disabled:` override; if the block becomes empty, drop the block.
            let body: Vec<String> = out[start + 1..end]
                .iter()
                .filter(|l| !l.trim_start().starts_with("disabled:"))
                .cloned()
                .collect();
            let kept: Vec<String> = body.into_iter().filter(|l| !l.trim().is_empty()).collect();
            if kept.is_empty() {
                out.drain(start..end);
                if start < out.len() && out[start].trim().is_empty() {
                    out.remove(start);
                }
            } else {
                out.splice(start + 1..end, kept);
            }
        } else {
            // Disable: ensure `disabled: true` is present.
            let has_disabled = out[start + 1..end]
                .iter()
                .any(|l| l.trim_start().starts_with("disabled:"));
            if !has_disabled {
                out.insert(start + 1, "  disabled: true".to_string());
            } else {
                for l in out[start + 1..end].iter_mut() {
                    if l.trim_start().starts_with("disabled:") {
                        let indent = &l[..l.len() - l.trim_start().len()];
                        *l = format!("{indent}disabled: true");
                    }
                }
            }
        }
    } else if !enabled {
        // Append a new block after the last non-blank line.
        let mut insert_at = out.len();
        while insert_at > 0 && out[insert_at - 1].trim().is_empty() {
            insert_at -= 1;
        }
        out.insert(insert_at, format!("- id: {id}"));
        out.insert(insert_at + 1, "  disabled: true".to_string());
    }

    while out.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        out.pop();
    }
    Ok(out.join("\n") + "\n")
}

/// Enable/disable one plugin by editing the profile patch layer. Writes a backup first.
pub fn plugins_set_enabled(cfg: &DshConfig, id: &str, enabled: bool) -> Result<String, String> {
    if id.trim().is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("插件 id 非法".to_string());
    }
    let home = dsh_home(cfg);
    let pp = patch_path(&home);
    if !pp.exists() {
        return Err(format!("未找到插件配置文件: {}", pp.display()));
    }
    let content =
        std::fs::read_to_string(&pp).map_err(|e| format!("读取 {} 失败: {e}", pp.display()))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let bak = pp.with_file_name(format!("cordis.patch.yml.bak-{stamp}"));
    std::fs::copy(&pp, &bak).map_err(|e| format!("备份 {} 失败: {e}", bak.display()))?;
    let next = toggle_patch(&content, id, enabled)?;
    std::fs::write(&pp, next).map_err(|e| format!("写入 {} 失败: {e}", pp.display()))?;
    Ok(format!(
        "{} 已{}（备份：{}）",
        id,
        if enabled { "启用" } else { "禁用" },
        bak.file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    ))
}

/// Import a plugin via `dsh plugin --profile web add <spec>` (pnpm).
pub fn plugins_import(cfg: &DshConfig, spec: &str) -> Result<String, String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("包名/路径不能为空".to_string());
    }
    let home = dsh_home(cfg);
    run_dsh_cli(&["plugin", "--profile", "web", "add", spec], &home)
        .map(|o| format!("导入成功（可能需要重启 dsh 生效）：\n{o}"))
}

/// Remove an imported plugin via `dsh plugin --profile web remove <name>` (pnpm).
pub fn plugins_remove(cfg: &DshConfig, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("插件名不能为空".to_string());
    }
    let home = dsh_home(cfg);
    run_dsh_cli(&["plugin", "--profile", "web", "remove", name], &home)
        .map(|o| format!("已移除（可能需要重启 dsh 生效）：\n{o}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DUMP: &str = "# == @deepseek-ai/dsh-base\n- id: timer\n  name: '@deepseek-ai/cordis-plugin-timer'\n# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app\n- id: hmr\n  name: '@deepseek-ai/cordis-plugin-hmr'\n  disabled: true\n- id: llm\n  name: '@deepseek-ai/dsh-llm'\n# == user patch\n- id: my-plugin\n  name: '@me/my-plugin'\n- id: cond-plugin\n  name: '@deepseek-ai/cond'\n  disabled: !!js process.platform === 'win32'\n";

    #[test]
    fn parses_dump_config() {
        let rows = parse_dump_config(DUMP);
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[0].id, "timer");
        assert!(rows[0].enabled);
        assert!(rows[0].builtin);
        assert_eq!(rows[1].id, "hmr");
        assert!(!rows[1].enabled);
        assert_eq!(rows[2].id, "llm");
        assert!(rows[2].builtin);
        assert_eq!(rows[3].id, "my-plugin");
        assert!(!rows[3].builtin);
        assert_eq!(rows[4].id, "cond-plugin");
        assert!(rows[4].conditional);
        assert!(rows[4].enabled);
    }

    #[test]
    fn toggles_empty_list() {
        let base = "# comment\n[]\n";
        let disabled = toggle_patch(base, "timer", false).unwrap();
        assert!(disabled.contains("- id: timer"));
        assert!(disabled.contains("disabled: true"));
        // disable again keeps a single entry
        let again = toggle_patch(&disabled, "timer", false).unwrap();
        assert_eq!(again.matches("disabled: true").count(), 1);
        // enable removes the override
        let enabled = toggle_patch(&again, "timer", true).unwrap();
        assert!(!enabled.contains("disabled:"));
    }

    #[test]
    fn toggles_existing_block() {
        let content = "# header\n- id: timer\n  name: '@deepseek-ai/cordis-plugin-timer'\n- id: llm\n  name: '@deepseek-ai/dsh-llm'\n";
        let disabled = toggle_patch(content, "llm", false).unwrap();
        assert!(disabled.contains("disabled: true"));
        let enabled = toggle_patch(&disabled, "llm", true).unwrap();
        assert!(!enabled.contains("disabled:"));
        assert!(enabled.contains("name: '@deepseek-ai/dsh-llm'"));
    }

    #[test]
    fn refuses_complex_patch() {
        let content = "# header\n- id: group\n  group: true\n  config:\n    - id: inner\n";
        let r = toggle_patch(content, "group", false);
        assert!(r.is_err());
    }

    #[test]
    fn invalid_id_rejected() {
        let cfg = DshConfig::default();
        assert!(plugins_set_enabled(&cfg, "bad id!", true).is_err());
        assert!(plugins_set_enabled(&cfg, "../evil", true).is_err());
    }
}
