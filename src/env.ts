import * as os from 'os';

/** Metadata auto-collected from the GitHub Actions environment. */
export interface ActionEnv {
  serverUrl: string;
  repository: string;
  runId: string;
  runAttempt: string;
  runUrl: string;
  sha: string;
  workspace: string;
  tempDir: string;
}

export function readActionEnv(): ActionEnv {
  const req = (name: string): string => {
    const v = process.env[name];
    if (!v) {
      throw new Error(`required environment variable ${name} is not set -- this action must run inside GitHub Actions`);
    }
    return v;
  };
  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const repository = req('GITHUB_REPOSITORY');
  const runId = req('GITHUB_RUN_ID');
  return {
    serverUrl,
    repository,
    runId,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
    runUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
    sha: req('GITHUB_SHA'),
    workspace: req('GITHUB_WORKSPACE'),
    tempDir: process.env.RUNNER_TEMP ?? os.tmpdir(),
  };
}
