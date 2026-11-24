# Pothos Prisma の書き込み直後の読み取りに関する調査

2026年11月24日に公開 npm パッケージで検証した結果です。[英語版レポート](investigation.md)

## 調査結果

GraphQL 17.1.0 と `@graphql-tools/executor` 2.0.1 の組み合わせでは、`@pothos/plugin-prisma` 4.17.1〜4.17.3 が `t.prismaField` で取得済みのリレーションを再取得します。再取得先の Reader に新しい親レコードがまだない場合、Writer は書き込みをコミットしますが、GraphQL は `result.posts` で Prisma の `P2025` エラーを返します。

検証した範囲では、4.17.0 まではこの回帰が発生せず、4.17.4 で解消しました。GraphQL.js 標準の実行エンジンでは、同じ mutation が検証対象の全7バージョンで成功しました。

## 検証環境と方法

- Node.js 24.22.1、pnpm 12.16.1、MySQL 8.4.7、Prisma Client 6.19.0、Pothos Core 4.18.1、GraphQL.js 17.1.0 を固定し、Pothos の Prisma プラグインをバージョンごとに別の Node.js プロセスで実行しました。
- 独立した MySQL コンテナ2台で Writer と Reader を用意し、Reader に書き込みがまだ反映されていない状態を作りました。各ケースの実行前後で、Reader にテスト対象の行が存在しないことを確認しています。
- `t.prismaField` の resolver は Pothos が生成した selection を `writer.user.create` に渡し、ユーザーと投稿1件を作成します。Writer が返した行に要求した投稿が含まれることと、GraphQL 実行後に両方のレコードが Writer に保存されていることを確認しました。
- Yoga で報告されたものと同じバージョンの `@graphql-tools/executor` を直接呼び出して検証しました。検証範囲は GraphQL の操作実行で、Yoga の HTTP 層は含みません。

2種類の実行エンジンで、同じ GraphQL ドキュメントを使いました。

```graphql
mutation {
  result: planned {
    posts {
      title
    }
  }
}
```

## バージョン別の検証結果

各セルの値は、Pothos の追加読み取り先を Reader にしたときの「GraphQL の結果 / Reader が実行した SQL の文数」です。テストデータの確認と削除に使った SQL は集計の対象外です。

| ケース | 4.15.0 | 4.16.0 | 4.17.0 | 4.17.1 | 4.17.2 | 4.17.3 | 4.17.4 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `t.prismaField` で公開スカラーを取得、GraphQL.js | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 |
| `t.prismaField` でリレーションを取得、GraphQL.js | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 |
| `t.prismaField` でリレーションを取得、GraphQL Tools executor 2 | OK / 0 | OK / 0 | OK / 0 | P2025 / 1 | P2025 / 1 | P2025 / 1 | OK / 0 |
| 名前付きフラグメントで同じリレーションを2つのエイリアスで取得、GraphQL.js | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 |
| 手動 resolver で公開スカラーを返す | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | OK / 0 | OK / 0 | OK / 0 |
| 手動 resolver で `select` を指定したカスタムスカラーを返す | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 |
| 手動 resolver で取得済みリレーションを返す | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 |
| `t.prismaField` で同じリレーションを異なるフィルターで要求 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 |

追加読み取り先を Writer にした対照実験は全56ケースで期待どおりのレスポンスを返し、Reader の SQL は0件でした。回帰があるバージョンでは Writer への追加読み取りが残りました。Writer に向けることで GraphQL の応答を正常化できますが、追加クエリ自体を解消するにはプラグインの修正が必要です。

手動 resolver では `t.field` と Prisma の `include` を使っています。行には列とリレーションが含まれますが、Pothos に GraphQL の selection mapping が登録されないため、Pothos はその値が要求された条件で取得されたか判定できず、再取得する場合があります。また、同じリレーションを2つのエイリアスから異なる引数で要求したケースでは、2回目の取得が仕様上必要です。[Pothos Prisma のリレーション仕様](https://pothos-graphql.dev/docs/plugins/prisma/relations)

## SQL の根拠と原因

[README の手順](../README.md#compare-the-regression-boundary)で 4.17.0、4.17.1、4.17.4 のトレースを比較できます。3バージョンとも mutation は `{ select: { posts: true, id: true } }` を Prisma に渡し、Writer は要求された投稿を返します。Writer は INSERT と mutation の戻り値を組み立てるための SELECT を実行してからコミットします。4.17.1 で追加読み取り先を Reader にした場合、コミットに続いて次の SQL が発行されました。

```sql
SELECT `repro`.`User`.`id` FROM `repro`.`User`
WHERE (`repro`.`User`.`id` = ? AND 1=1) LIMIT ? OFFSET ?
```

4.17.0 と 4.17.4 ではこの追加の SELECT は発行されません。4.17.1 では、GraphQL のエラーパスは `["result", "posts"]`、Prisma のエラーコードは `P2025` でした。

影響を受ける selection mapper は、`info.getAbortSignal` の関数オブジェクトをキーにして loader の状態を管理していました。GraphQL Tools executor 2 は resolver ごとに異なる関数を生成するため、リレーションの resolver が親の記録した selection mapping を見つけられません。その結果、Pothos は `ModelLoader` にフォールバックし、SchemaBuilder に設定された Prisma Client で親レコードを再取得します。修正では、各 resolver が共有する `info.path` の先頭のリンクをキーに使います。[修正 PR #1859](https://github.com/hayes/pothos/pull/1859)・[修正コミット](https://github.com/hayes/pothos/commit/3f99569)

## 上流の Issue と修正状況

- この実行エンジン固有の再取得は [Issue #1858](https://github.com/hayes/pothos/issues/1858) で報告され、クローズ済みです。[PR #1859](https://github.com/hayes/pothos/pull/1859) がマッピングのキーを修正し、[リリース PR #1860](https://github.com/hayes/pothos/pull/1860) が `@pothos/selection-mapper` 0.3.1 を通じて `@pothos/plugin-prisma` 4.17.4 に取り込みました。公開済みの 4.17.4 で修正を確認しました。
- [PR #1847](https://github.com/hayes/pothos/pull/1847) による別の最適化は 4.17.2 に含まれます。取得済みの行に公開スカラーや列挙型の値があれば、その値を直接返します。手動 resolver の公開スカラーのケースは 4.17.2 から成功し、カスタムスカラーとリレーションのケースでは引き続き追加読み取りが発生しました。
- [Issue #1475](https://github.com/hayes/pothos/issues/1475)、[Issue #1582](https://github.com/hayes/pothos/issues/1582)、[ドラフト PR #1583](https://github.com/hayes/pothos/pull/1583) は、Drizzle で起きた類似事例です。Prisma の `P2025`、レプリカ読み取り、mutation の追加読み取り、実行エンジンのキャッシュキーを検索した結果、今回再現した回帰に直接対応するのは #1858 と #1859 でした。

## 対応方針

本番環境のロックファイルと失敗した selection を再現条件と照合してください。本番で使用していた依存関係の正確なバージョン、スキーマ、接続先の切り替え方式は今回の調査では確認できていません。

条件が一致する場合は `@pothos/plugin-prisma` を 4.17.4 以降に更新し、解決された selection mapper のバージョンを確認してください。mutation 中に追加読み取りが発生し得る場合は、Pothos の読み取りも書き込みに使った Writer に向けます。対照実験では、異なるフィルターによる仕様上必要な追加読み取りも、この接続先の設定で成功しました。
