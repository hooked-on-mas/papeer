# Rust 依存関係の残存警告

2026-10-18 の作業ツリーの `frontend/src-tauri/Cargo.lock` を確認した記録です。公開済みのタグ・バイナリにこの変更が適用されたことを示すものではありません。

`cargo-audit 0.22.2` の結果は **vulnerability 0 件、informational warning 5 件**です。警告には Linux で選択される `glib` の未修正の unsoundness が含まれます。`cargo audit` の終了コード 0 は「警告もない」「Linux の問題が修正済み」という意味ではありません。警告の ignore は追加していません。

監査 DB は `999ec89d5d3f10f20be14750ec8c2d8b44e0ac9b`（2026-10-17 更新、1,338 advisories）、監査対象は 499 dependencies でした。DB が更新されれば結果は変わります。CI と Release は毎回監査しますが、現行の `cargo audit` 標準動作では informational warning はログに表示され、失敗にはなりません。

## 今回解消した 6 件

| 変更 | 解消した警告と依存経路 |
| --- | --- |
| `tauri-utils 2.9.3 → 2.10.2` | `tauri-utils → urlpattern 0.3.0 → unic-* 0.9.0` の未保守 5 件。新しい `urlpattern 0.6.0` への移行により、`unic-char-property`、`unic-char-range`、`unic-common`、`unic-ucd-ident`、`unic-ucd-version` が lock から消えました。 |
| `yoke-derive 0.8.3 → 0.8.4` | `url → idna → ICU → yoke → yoke-derive` の yanked 1 件。`yoke 0.8.3` の `^0.8.2` 制約内で解決しました。 |

[tauri-utils 2.10.2 の公式 manifest](https://github.com/tauri-apps/tauri/blob/tauri-utils-v2.10.2/crates/tauri-utils/Cargo.toml) は `urlpattern = "0.6"` を指定しています。更新は Cargo が認める制約内に限定し、Tauri 本体 `2.11.6`、直接依存プラグイン、アプリの API は変更していません。関連する transitive dependencies も lock に反映しています。

## 残る 5 件と単純な更新では解消しない理由

| 対象 | アプリからの経路と影響 | 残す理由・次の対応 |
| --- | --- | --- |
| `glib 0.18.5` / [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) | Linux: `tauri 2.11.6 → gtk 0.18.2 → glib`。WebKitGTK、tray-icon、muda 等にも同系列への経路があります。`VariantStrIter` の iterator 実装に未定義動作があり、最適化時の NULL pointer dereference 等につながります。 | 修正版は `glib >=0.20.0` ですが GTK 3 bindings は `glib ^0.18` を要求します。アプリに新しい glib を追加しても GTK 側の古い型・依存は置き換わりません。[Tauri 2.12.4 の公式 manifest](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.4/crates/tauri/Cargo.toml) も Linux に `gtk 0.18` を指定しています。Tauri/GTK 側の互換修正、または検証可能な upstream backport が必要です。 |
| `proc-macro-error 1.0.4` / [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html) | Linux のビルド経路: `gtk → gtk3-macros 0.18.2` および `glib → glib-macros 0.18.5 → proc-macro-error`。アプリのランタイム入力を処理するコードではなく proc macro の依存です。 | 両 macro crate が `proc-macro-error ^1.0` を要求します。RustSec に patched version はなく、別 crate への移行は macro 側の変更が必要です。GTK 系の更新を追跡します。 |
| `zbus_names 4.3.4` / [RUSTSEC-2026-0371](https://rustsec.org/advisories/RUSTSEC-2026-0371.html) | Linux: `tauri-plugin-notification 2.4.0 → notify-rust 4.18.0 → zbus 5.19.0`、および `tauri-plugin-opener 2.5.5 → zbus`。名前の型を提供します。 | 独立 crate は未保守となり、機能は `zbus >=6` の `names` に統合されました。現行 consumers は zbus 5 を要求します。通知と opener の両方の zbus 6 対応が必要です。 |
| `zvariant 5.15.0` / [RUSTSEC-2026-0370](https://rustsec.org/advisories/RUSTSEC-2026-0370.html) | 上記の zbus と zbus_names が利用する D-Bus serialization の依存です。 | 機能は `zbus >=6` の `wire` に統合され、独立 crate の patched version はありません。zbus 5 系の patch 更新では解消しません。 |
| `zvariant_derive 5.15.0` / [RUSTSEC-2026-0372](https://rustsec.org/advisories/RUSTSEC-2026-0372.html) | 上記 zvariant の derive macro。 | derive macros も `zbus >=6` に統合されました。zbus consumers の移行に合わせて解消します。 |

`notify-rust` の最新ソースでも [4.18.2 は zbus 5 を指定](https://github.com/hoodie/notify-rust/blob/main/Cargo.toml)しています。この未保守警告は 2026-10-16 の分割 crate 廃止に関するもので、上記 3 件自体が実証済みのアプリ攻撃経路を報告しているわけではありません。互換性を壊す強制的な dependency patch や Tauri major migration は行っていません。

`frontend/src-tauri/src` に `VariantStrIter` / `str_iter` の直接利用は見つかりませんでした。ただし、これは全推移依存の間接呼び出しや Linux 実行時の到達不能性を証明しません。Linux の unsoundness は未解決として扱います。

## OS ごとの範囲と検証

`cargo tree --offline --locked --target <target> -i <package>` で、配布対象 4 種類を個別に確認しました。

| target | 残存警告の crate |
| --- | --- |
| `x86_64-pc-windows-msvc` | glib / proc-macro-error / zbus 系はいずれも非選択 |
| `aarch64-apple-darwin` | 同上 |
| `x86_64-apple-darwin` | 同上 |
| `x86_64-unknown-linux-gnu` | 上記 5 件の経路を選択 |

Windows、Rust 1.98.1 で更新後の実コンパイルと unit tests を実施し、17 passed / 2 ignored でした。2 件は実 sidecar bundle を必要とする既存の ignored tests です。検証時は `TAURI_CONFIG='{"bundle":{"resources":[]}}'` を指定し、release profile の LTO を無効、codegen-units を 256、opt-level を 0 にしてコンパイルしました。これは最適化した Linux 配布ビルドの動作検証を代替しません。Linux / macOS の実ビルドと installer 内の通知検査は Release workflow で実施します。

再確認コマンド（リポジトリルート）:

```text
cargo audit --file frontend/src-tauri/Cargo.lock
cargo tree --offline --locked --manifest-path frontend/src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu -i glib
cargo tree --offline --locked --manifest-path frontend/src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu -i proc-macro-error
cargo tree --offline --locked --manifest-path frontend/src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu -i zbus
```

上流に互換修正が出た時点で更新し、この記録と各 OS の台帳・配布通知を再生成してください。Linux 配布の判断時には、成功表示だけでなく上記 unsoundness の残存を確認する必要があります。
