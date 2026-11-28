# ローカル検証記録

作業の大分類・小分類は[共通化計画のTODO](../docs/shared-app-plan.md#3-実行todo大分類小分類)で管理する。[引継ぎ書](../docs/shared-app-handover.md)と[現在の再開記録](shared-app/2026-10-30-p4-workspace/RESTART-CURRENT.md)から、現行ソース・実行結果・次の作業を確認できる。

`shared-app/<milestone>/` は原ログ、失敗記録、ソースの退避、manifest、検証・配布用の補助ソースを保存する場所。既存のパスとhashによる参照を保ち、記録を残す。GitではこのREADMEを入口とし、配下のローカル記録は除外する。

今後の使い捨ての一時出力は、既に除外済みの `output/qa/<run>/` に置く。継続利用する補助ソースは個別に管理対象を決める。移動やアーカイブは参照元を確認して小さなまとまりで行う。

除外した記録のファイル一覧が必要な場合は、対象を絞って `rg --files --no-ignore checkpoints/shared-app/<milestone>` を使う。
