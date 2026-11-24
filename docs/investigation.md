# Pothos Prisma read-after-write investigation

Verified on 2026-11-24 against published npm packages.

## Finding

With GraphQL 17.1.0 and `@graphql-tools/executor` 2.0.1, `@pothos/plugin-prisma` 4.17.1 through 4.17.3 reloads an already selected relation beneath `t.prismaField`. If Pothos routes the reload to a Reader that lacks the new parent row, the Writer commits the mutation and GraphQL reports Prisma `P2025` at `result.posts`. Version 4.17.0 is the last passing version before the regression in this matrix, and 4.17.4 is the first passing release after it. The same mutation succeeds through the native GraphQL.js 17 executor across all seven tested plugin releases.

## Test setup

- Node.js 24.22.1, pnpm 12.16.1, MySQL 8.4.7, Prisma Client 6.19.0, Pothos Core 4.18.1, and GraphQL.js 17.1.0 were held constant. Each plugin version ran in its own Node process.
- Two independently initialized MySQL containers model a Writer and a Reader that has yet to receive the write. The harness verifies that the Reader lacks the fixture row both before and after execution.
- The planned resolver spreads the Pothos selection into `writer.user.create` and creates a user with one post. The test checks the actual returned relation and verifies both records on the Writer after GraphQL execution.
- The alternate executor is the same engine and version reported with Yoga in the upstream issue. The harness calls it directly and exercises GraphQL operation execution independently of Yoga's HTTP layer.

The two executor cases use this exact GraphQL document.

```graphql
mutation {
  result: planned {
    posts {
      title
    }
  }
}
```

## Version matrix

Each cell shows the GraphQL result and number of SQL statements emitted by the **Reader** during execution when Pothos fallback reads are routed there. Fixture checks and cleanup run outside that trace.

| Case | 4.15.0 | 4.16.0 | 4.17.0 | 4.17.1 | 4.17.2 | 4.17.3 | 4.17.4 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Planned exposed scalar, GraphQL.js | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 |
| Planned relation, GraphQL.js | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 |
| Planned relation, GraphQL Tools executor 2 | OK / 0 | OK / 0 | OK / 0 | P2025 / 1 | P2025 / 1 | P2025 / 1 | OK / 0 |
| Planned relation with two aliases in a named fragment, GraphQL.js | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 | OK / 0 |
| Manual resolver, exposed scalar | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | OK / 0 | OK / 0 | OK / 0 |
| Manual resolver, custom selected scalar | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 |
| Manual resolver, preloaded relation | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 |
| Planned relation with conflicting filter arguments | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 | P2025 / 1 |

All 56 Writer-route controls returned the expected payload with zero Reader statements. The affected executor case still issued additional Writer reads when routed to the Writer. That routing restores read-after-write consistency while leaving the extra reads observable.

The manual resolver uses `t.field` with a Prisma `include`. It returns the columns and relation but does not register a GraphQL selection mapping. Pothos can reload these fields because the row lacks evidence of how its values were selected. For instance, two aliases can request the same relation with different arguments. The conflicting-filter case deliberately needs a second fetch and is documented Pothos behavior. [Pothos Prisma relations](https://pothos-graphql.dev/docs/plugins/prisma/relations)

## SQL evidence and cause

Run the boundary trace from the [README](../README.md). On all three boundary versions, the planned mutation passes `{ select: { posts: true, id: true } }` to Prisma and the Writer returns the requested post. The Writer performs the inserts and the reads required to build the mutation result, then commits. In the 4.17.1 Reader-route trace, the next statement is a Reader lookup of the new parent row.

```sql
SELECT `repro`.`User`.`id` FROM `repro`.`User`
WHERE (`repro`.`User`.`id` = ? AND 1=1) LIMIT ? OFFSET ?
```

This extra statement is absent in the corresponding 4.17.0 and 4.17.4 traces. The 4.17.1 trace ends with GraphQL error path `["result", "posts"]` and Prisma code `P2025`.

The affected selection mapper keys its loader state on the identity of `info.getAbortSignal`. GraphQL Tools executor 2 creates a different getter for each resolver, so the relation resolver cannot find the selection mapping recorded by the parent. Pothos falls back to `ModelLoader`, which looks up the parent through the builder's configured Prisma client. The fix keys the state on the shared root link of `info.path`. [Fix PR #1859](https://github.com/hayes/pothos/pull/1859), [fix commit](https://github.com/hayes/pothos/commit/3f99569)

## Upstream status

- [Issue #1858](https://github.com/hayes/pothos/issues/1858) reports the executor-specific refetch and is closed. [PR #1859](https://github.com/hayes/pothos/pull/1859) fixes the mapping key. [Release PR #1860](https://github.com/hayes/pothos/pull/1860) ships the fix through `@pothos/selection-mapper` 0.3.1 in `@pothos/plugin-prisma` 4.17.4. The published 4.17.4 package passed the MySQL reproduction.
- [PR #1847](https://github.com/hayes/pothos/pull/1847) shipped a separate optimization in 4.17.2. It resolves an exposed scalar or enum directly when the row already has a value. The exposed scalar fixture passes starting at 4.17.2. The custom scalar and relation fixtures still take the fallback path.
- [Issue #1475](https://github.com/hayes/pothos/issues/1475), [issue #1582](https://github.com/hayes/pothos/issues/1582), and [draft PR #1583](https://github.com/hayes/pothos/pull/1583) concern Drizzle and provide context for similar symptoms. Searches for Prisma `P2025`, replica reads, mutation fallbacks, and the executor cache key identified #1858 and #1859 as the direct match for the reproduced regression.

## Applying the result

Upgrade to `@pothos/plugin-prisma` 4.17.4 or later for the GraphQL Tools executor regression and confirm the resolved selection mapper version. Route Pothos reads during mutations to the same Writer client when a fallback is possible. The Writer-route control verifies that this also handles the legitimate extra fetch for conflicting relation arguments.

The historical deployment's exact dependency versions, schema, and routing implementation are unknown. Compare its lockfile and failing selection with this reproduction before attributing the original incident to #1858.
