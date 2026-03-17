import fs from 'fs';
import path from 'path';

import { Orchestrator } from './orchestrator';
import { ensureAegisInitialized } from './setup';
import { ArtifactStore } from './store';

export function parseCliArgs(argv: string[]) {
  const flags = new Set<string>();
  const errors: string[] = [];
  let listSessions = false;
  let sessionId: string | undefined;
  let startStage: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--from') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        errors.push('Missing value for --from. Example: aegis demo-session --from stage6');
      } else {
        startStage = value;
        index += 1;
      }
      continue;
    }

    if (arg.startsWith('--from=')) {
      startStage = arg.slice('--from='.length);
      if (!startStage) {
        errors.push('Missing value for --from. Example: aegis demo-session --from stage6');
      }
      continue;
    }

    if (arg === '--sessions') {
      listSessions = true;
      continue;
    }

    if (arg.startsWith('-')) {
      if (!['--setup', '--help', '-h', '--version', '-v', '--sessions'].includes(arg)) {
        errors.push(`Unknown option: ${arg}`);
      }
      flags.add(arg);
      continue;
    }

    if (!sessionId) {
      sessionId = arg;
      continue;
    }

    errors.push(`Unexpected argument: ${arg}`);
  }

  return {
    errors,
    forceSetup: flags.has('--setup'),
    help: flags.has('--help') || flags.has('-h'),
    listSessions,
    sessionId,
    startStage,
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
      '  --from <stage>  Resume from a specific stage and invalidate that stage plus downstream artifacts',
      '  --sessions      List saved sessions with project and stage context',
      '  -h, --help      Show help, workflow, and output locations',
      '  -v, --version   Show CLI version',
      '',
      'Examples:',
      '  aegis',
      '  aegis --sessions',
      '  aegis demo-session',
      '  aegis demo-session --from stage6',
      '  aegis demo-session --from execution',
      '  aegis demo-session --from strategy',
      '  aegis --setup',
      '  aegis -h',
      '',
      'Stages for --from:',
      ...Orchestrator.getStartStageHelpLines(),
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

function printSessions() {
  const sessions = ArtifactStore.listSessions();

  if (sessions.length === 0) {
    console.log('No saved sessions found in ~/.aegisflow/sessions');
    return;
  }

  console.log(
    [
      'Saved Sessions',
      '',
      ...sessions.map(session =>
        [
          `- ${session.sessionId}`,
          `  project: ${session.projectLabel || 'unknown'}`,
          `  workspace: ${session.workspace || 'unknown'}`,
          `  created: ${session.createdAt}`,
          `  stage: ${session.currentStage ? `${session.currentStage}${session.currentStatus ? ` (${session.currentStatus})` : ''}` : 'unknown'}`,
          `  resume: aegis ${session.sessionId}`,
        ].join('\n'),
      ),
    ].join('\n'),
  );
}

export async function main(argv = process.argv.slice(2)) {
  const { errors, forceSetup, help, listSessions, sessionId, startStage, version } = parseCliArgs(argv);

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  if (help) {
    printHelp();
    return;
  }

  if (version) {
    console.log(readPackageVersion());
    return;
  }

  if (listSessions) {
    if (sessionId || startStage || forceSetup) {
      throw new Error('`--sessions` cannot be combined with a session-id, `--from`, or `--setup`.');
    }
    printSessions();
    return;
  }

  const normalizedStartStage = startStage ? Orchestrator.parseStartStage(startStage) : undefined;
  if (normalizedStartStage && normalizedStartStage !== 'stage0' && !sessionId) {
    throw new Error('`--from` requires a session-id when starting after stage0. Example: aegis demo-session --from stage6');
  }

  await ensureAegisInitialized({ force: forceSetup });
  const runner = new Orchestrator(sessionId, { startStage: normalizedStartStage });
  await runner.run();
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal Error:', err);
    process.exit(1);
  });
}
