import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageNames = {
  '4.15.0': 'prisma-4-15-0',
  '4.16.0': 'prisma-4-16-0',
  '4.17.0': 'prisma-4-17-0',
  '4.17.1': 'prisma-4-17-1',
  '4.17.2': 'prisma-4-17-2',
  '4.17.3': 'prisma-4-17-3',
  '4.17.4': '@pothos/plugin-prisma',
};

const versions = process.argv.slice(2);
if (versions.length === 0) versions.push(...Object.keys(packageNames));

for (const version of versions) {
  if (!Object.hasOwn(packageNames, version)) {
    console.error(`Unknown version: ${version}. Available: ${Object.keys(packageNames).join(', ')}`);
    process.exit(1);
  }

  // Each plugin registers itself against the same Pothos core on import.
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./run-version.mjs', import.meta.url)), version, packageNames[version]],
    { stdio: 'inherit' },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
}
