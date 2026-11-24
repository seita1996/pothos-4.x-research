import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { execute as executeWithTools } from '@graphql-tools/executor';
import SchemaBuilder from '@pothos/core';
import { Prisma, PrismaClient } from '@prisma/client';
import { graphql, parse } from 'graphql';

const [version, packageName] = process.argv.slice(2);
const { default: PrismaPlugin } = await import(packageName);

const statements = [];
function connect(port) {
  const client = new PrismaClient({
    datasourceUrl: `mysql://repro:local-repro-only@127.0.0.1:${port}/repro`,
    log: [{ emit: 'event', level: 'query' }],
  });
  client.$on('query', ({ query }) => statements.push({ client, query }));
  return client;
}

const writer = connect(process.env.WRITER_PORT ?? '33061');
const reader = connect(process.env.READER_PORT ?? '33062');

async function createUser(query, context) {
  context.writerQuery = query;
  const row = await writer.user.create({
    ...query,
    data: {
      id: context.id,
      name: 'Ada',
      posts: { create: { id: context.id, title: 'First post' } },
    },
  });
  context.writerResult = row;
  return row;
}

const builder = new SchemaBuilder({
  plugins: [PrismaPlugin],
  prisma: {
    client: (context) => context.fallbackClient,
    dmmf: Prisma.dmmf,
  },
});

builder.prismaObject('Post', {
  fields: (t) => ({ title: t.exposeString('title', { nullable: false }) }),
});

const user = builder.prismaObject('User', {
  select: { id: true },
  fields: (t) => ({
    name: t.exposeString('name', { nullable: false }),
    label: t.field({
      type: 'String',
      nullable: false,
      select: { name: true },
      resolve: (parent) => parent.name,
    }),
    posts: t.relation('posts', {
      args: { title: t.arg.string() },
      query: (args) => (args.title ? { where: { title: args.title } } : {}),
    }),
  }),
});

builder.queryType({ fields: (t) => ({ ready: t.boolean({ resolve: () => true }) }) });

builder.mutationType({
  fields: (t) => ({
    planned: t.prismaField({
      type: 'User',
      resolve: (query, _parent, _args, context) => createUser(query, context),
    }),
    manual: t.field({
      type: user,
      resolve: (_parent, _args, context) =>
        createUser({ include: { posts: true } }, context),
    }),
  }),
});

const schema = builder.toSchema();
const exposedScalarReloads = ['4.15.0', '4.16.0', '4.17.0', '4.17.1'].includes(version);
const executorMappingRegression = ['4.17.1', '4.17.2', '4.17.3'].includes(version);
const cases = [
  { name: 'plannedScalar', field: 'planned', selection: 'name', expected: { name: 'Ada' } },
  {
    name: 'executorPlannedRelation',
    field: 'planned',
    selection: 'posts { title }',
    executor: 'tools',
    readerError: executorMappingRegression,
    expected: { posts: [{ title: 'First post' }] },
  },
  {
    name: 'plannedRelation',
    field: 'planned',
    selection: 'posts { title }',
    expected: { posts: [{ title: 'First post' }] },
  },
  {
    name: 'plannedAliasedRelation',
    field: 'planned',
    selection: '...Fields',
    fragment: 'fragment Fields on User { first: posts { title } second: posts { title } }',
    expected: { first: [{ title: 'First post' }], second: [{ title: 'First post' }] },
  },
  {
    name: 'manualScalar',
    field: 'manual',
    selection: 'name',
    readerError: exposedScalarReloads,
    expected: { name: 'Ada' },
  },
  {
    name: 'manualCustomScalar',
    field: 'manual',
    selection: 'label',
    readerError: true,
    expected: { label: 'Ada' },
  },
  {
    name: 'manualRelation',
    field: 'manual',
    selection: 'posts { title }',
    readerError: true,
    expected: { posts: [{ title: 'First post' }] },
  },
  {
    name: 'conflictingRelation',
    field: 'planned',
    selection: 'first: posts(title: "First post") { title } missing: posts(title: "Missing") { title }',
    readerError: true,
    expected: { first: [{ title: 'First post' }], missing: [] },
  },
];

async function runCase(scenario, route) {
  const id = randomInt(1, 2 ** 31);
  const context = { id, fallbackClient: route === 'reader' ? reader : writer };

  assert.equal(await reader.user.count({ where: { id } }), 0, 'Reader must start stale');
  assert.equal(await writer.user.count({ where: { id } }), 0, 'Fixture ID already exists');

  try {
    statements.length = 0;
    const source = `mutation { result: ${scenario.field} { ${scenario.selection} } } ${scenario.fragment ?? ''}`;
    const args = { schema, contextValue: context };
    const result = scenario.executor === 'tools'
      ? await executeWithTools({ ...args, document: parse(source) })
      : await graphql({ ...args, source });
    const operations = statements.map(({ client, query }) => ({
      server: client === writer ? 'writer' : 'reader',
      sql: query,
    }));
    const readerQueries = operations.filter(({ server }) => server === 'reader').length;
    const errors = (result.errors ?? []).map((error) => ({
      path: error.path,
      code: error.originalError?.code,
      message: error.message.trim().split('\n').at(-1),
    }));

    if (scenario.name === 'plannedRelation' || scenario.name === 'executorPlannedRelation') {
      assert.equal(context.writerResult?.posts?.[0]?.title, 'First post', 'Writer must return posts');
    }
    const stored = await writer.user.findUnique({ where: { id }, include: { posts: true } });
    assert.equal(stored?.name, 'Ada', 'Mutation must commit its Writer row');
    assert.equal(stored.posts[0]?.title, 'First post', 'Mutation must commit the related row');
    assert.equal(await reader.user.count({ where: { id } }), 0, 'Reader must remain stale');

    const expectsReloadError = route === 'reader' && Boolean(scenario.readerError);
    assert.equal(readerQueries, expectsReloadError ? 1 : 0, JSON.stringify({ errors, operations }));
    if (scenario.name === 'executorPlannedRelation') {
      const commitIndex = operations.findIndex(({ server, sql }) => server === 'writer' && sql === 'COMMIT');
      assert.ok(commitIndex >= 0, 'Writer must commit during the mutation');
      const extraReads = operations.slice(commitIndex + 1);
      const expectedReads = executorMappingRegression ? (route === 'reader' ? 1 : 2) : 0;
      assert.equal(extraReads.length, expectedReads, JSON.stringify(extraReads));
      assert.ok(extraReads.every(({ server, sql }) => server === route && sql.startsWith('SELECT ')));
      if (expectsReloadError) assert.deepEqual(errors[0]?.path, ['result', 'posts']);
    }
    if (expectsReloadError) {
      assert.ok(operations.some(({ server, sql }) => server === 'reader' && /^SELECT\b/i.test(sql)));
      assert.ok(errors.length > 0, 'Expected a GraphQL error from the Reader lookup');
      assert.ok(
        errors.every(({ code, path }) => code === 'P2025' && path?.[0] === 'result'),
        JSON.stringify(errors),
      );
    } else {
      assert.deepEqual(JSON.parse(JSON.stringify(result.data)), { result: scenario.expected });
    }

    console.log(`${scenario.name.padEnd(23)} ${route.padEnd(6)} ${errors.length ? 'P2025' : 'OK   '} reader SQL: ${readerQueries}`);
    if (process.env.TRACE_SQL === '1') {
      console.log(JSON.stringify({
        writerQuery: context.writerQuery,
        writerResult: context.writerResult,
        operations,
        errors,
      }, null, 2));
    }
  } finally {
    await writer.post.deleteMany({ where: { authorId: id } });
    await writer.user.deleteMany({ where: { id } });
  }
}

console.log(`\n@pothos/plugin-prisma ${version}`);
try {
  const caseName = process.env.REPRO_CASE;
  const selected = caseName ? cases.filter(({ name }) => name === caseName) : cases;
  assert.ok(selected.length, `Unknown case: ${caseName}`);
  for (const scenario of selected) {
    await runCase(scenario, 'reader');
    await runCase(scenario, 'writer');
  }
} finally {
  await Promise.all([writer.$disconnect(), reader.$disconnect()]);
}
