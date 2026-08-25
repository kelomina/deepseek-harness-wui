# Fixtures 来源与许可（PROVENANCE）

- 来源仓库：https://github.com/T-Auto/dsh-ecosystem-spec （MIT License）
- 来源路径：`conformance/fixtures/`
- 复制日期：2026-08-24
- 对应上游基线：`vendor/dsh-std` revision `614dfa1ac168db79fcf4577cf0ebb34e2e3b944b`（community-consensus v0.15）
- 本地修改：无（原样复制，仅选取 manifest 正反例子集）

用途：`node --test test/` 中校验本 sidecar 的 admission 管道与上游 conformance 语义一致
（valid → compatible*；invalid-* → rejected）。更新上游 revision 时必须同步本目录并复跑测试。
