# Pothos Prisma read-after-write reproduction

This repository reproduces a Pothos Prisma selection-mapping regression that can turn a successful MySQL write into a GraphQL response error. With GraphQL 17 and `@graphql-tools/executor` 2, `@pothos/plugin-prisma` 4.17.1–4.17.3 reloads a relation the mutation already fetched. The response fails if that reload is routed to a Reader that has yet to see the new row. Version 4.17.4 fixes this regression. See the [investigation report](docs/investigation.md) for the full version matrix and upstream references.

## Run the reproduction

Use Docker with Compose v2 or newer, Node.js 24, and pnpm 12.16.1.

```sh
pnpm install --frozen-lockfile
pnpm generate
docker compose up -d --wait
pnpm repro
```

Compose starts two independent MySQL 8.4.7 instances with the same schema. Both ports are bound to loopback. The Writer listens on port 33061 and the Reader on 33062. Set `WRITER_PORT` and `READER_PORT` in the shell before starting Compose and running pnpm if those ports are in use. Each database stores its data in a temporary filesystem, and the harness uses synthetic `User` and `Post` fixtures.

The runner invokes GraphQL directly. For each case, it routes Pothos fallback reads first to the Reader and then to the Writer. The mutation itself always uses the Writer. An expected `P2025` is a passing reproduction. An unexpected result or SQL count exits with an error.

## Compare the regression boundary

```sh
REPRO_CASE=executorPlannedRelation TRACE_SQL=1 pnpm repro 4.17.0 4.17.1 4.17.4
```

For the Reader route, expect `OK`, `P2025`, and `OK` respectively, with Reader SQL counts of 0, 1, and 0. All three should return the expected response when fallback reads use the Writer. `TRACE_SQL=1` prints the generated Prisma selection, the Writer's returned row, SQL tagged by destination, and GraphQL error paths.

Stop the two MySQL instances and discard the temporary data with `docker compose down`.
