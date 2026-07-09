import * as core from '@actions/core';
import { runMain } from './main';
import { runPost } from './post';

// Single bundle serves runs.main and runs.post (actions/checkout stateHelper
// pattern): the main invocation saves isPost, so the post invocation branches.
const isPost = !!core.getState('isPost');
if (!isPost) core.saveState('isPost', 'true');

(isPost ? runPost() : runMain()).catch((err: unknown) => {
  if (err instanceof Error && err.stack) core.info(err.stack);
  core.setFailed(err instanceof Error ? err.message : String(err));
});
