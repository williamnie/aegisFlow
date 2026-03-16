import fs from 'fs';
import path from 'path';

import { Orchestrator } from './orchestrator';
import { ensureAegisInitialized } from './setup';

export function parseCliArgs(argv: string[]) {
  const flags = new Set<string>();
  let sessionId: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith('-')) {
      flags.add(arg);
      continue;
    }

    if (!sessionId) {
      sessionId = arg;
    }
  }

  return {
    forceSetup: flags.has('--setup'),
    help: flags.has('--help') || flags.has('-h'),
    sessionId,
    version: flags.has('--version') || flags.has('-v'),
  };
}

function readPackageVersion(): string {
  const packageJsonPath = path.resolve(__dirname, '..', 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    return '0.0.0';
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
  return packageJson.version || '0.0.0';
}

function printHelp() {
  console.log(
    [
      'AegisFlow CLI',
      '',
      'Usage:',
      '  aegis [session-id] [options]',
      '  aeigs [session-id] [options]',
      '  aegisflow [session-id] [options]',
      '',
      'Options:',
      '  --setup         Run interactive setup and engine detection again',
      '  -h, --help      Show help, workflow, and output locations',
      '  -v, --version   Show CLI version',
      '',
      'Examples:',
      '  aegis',
      '  aegis demo-session',
      '  aegis --setup',
      '  aegis -h',
      '',
      'Workflow:',
      '  idea intake -> requirement gate -> PRD -> technical design',
      '  independent reviews -> roundtable -> task plan -> execution -> integration review',
      '',
      'Outputs:',
      '  workspace: prd.md, design.md',
      '  session archive: ~/.aegisflow/sessions/<session-id>/archive',
      '  resume: rerun with the same session-id',
    ].join('\n'),
  );
}

export async function main(argv = process.argv.slice(2)) {
  const { forceSetup, help, sessionId, version } = parseCliArgs(argv);

  if (help) {
    printHelp();
    return;
  }

  if (version) {
    console.log(readPackageVersion());
    return;
  }

  await ensureAegisInitialized({ force: forceSetup });
  const runner = new Orchestrator(sessionId);
  await runner.run();
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal Error:', err);
    process.exit(1);
  });
}
