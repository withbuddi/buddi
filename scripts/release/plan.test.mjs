import { describe, expect, test } from 'vitest';
import { checkPublish, decide, parseRequest, requestFile } from './plan.mjs';

const sha = (c) => c.repeat(40);
const request = requestFile('0.1.0-pre.44', sha('0'));
const tags = (...existing) => (tag) => existing.includes(tag);

/** HEAD first: `subjects[0]` is HEAD. */
function history(...subjects) {
  return subjects.map((subject, i) => ({ sha: sha(String.fromCharCode(97 + i)), subject }));
}

describe('decide', () => {
  test('a release commit whose version is untagged: tag it', () => {
    const commits = history('Release 0.1.0-pre.44', 'Mail: a reading pane');
    const plan = decide({ head: commits[0].sha, commits, markerSha: commits[0].sha, requestText: request, packageVersion: '0.1.0', tagExists: tags('v0.1.0-pre.43') });
    expect(plan).toMatchObject({ action: 'tag', version: '0.1.0-pre.44', tag: 'v0.1.0-pre.44', sha: commits[0].sha, onTop: 0 });
  });

  test('a fix on top of the release commit: tag HEAD, the fix included', () => {
    const commits = history('Fix the flaky gateway test', 'Gate: pin postgres', 'Release 0.1.0-pre.44', 'Mail: a reading pane');
    const plan = decide({ head: commits[0].sha, commits, markerSha: commits[2].sha, requestText: request, packageVersion: '0.1.0', tagExists: tags() });
    expect(plan).toMatchObject({ action: 'tag', tag: 'v0.1.0-pre.44', sha: commits[0].sha, marker: commits[2].sha, onTop: 2 });
  });

  test('already tagged: nothing', () => {
    const commits = history('Fix after the release', 'Release 0.1.0-pre.44');
    const plan = decide({ head: commits[0].sha, commits, markerSha: commits[1].sha, requestText: request, packageVersion: '0.1.0', tagExists: tags('v0.1.0-pre.44') });
    expect(plan.action).toBe('none');
    expect(plan.reason).toMatch(/already exists/);
  });

  test('a push that is not a release: nothing', () => {
    const commits = history('Mail: a reading pane', 'Chat: smoother divider');
    expect(decide({ head: commits[0].sha, commits, markerSha: null, requestText: null, packageVersion: '0.1.0', tagExists: tags() }).action).toBe('none');
  });

  test('a version that does not match package.json: fail', () => {
    const commits = history('Release 0.2.0-pre.1');
    const plan = decide({ head: commits[0].sha, commits, markerSha: commits[0].sha, requestText: requestFile('0.2.0-pre.1', sha('0')), packageVersion: '0.1.0', tagExists: tags() });
    expect(plan.action).toBe('fail');
    expect(plan.reason).toMatch(/package\.json is at 0\.1\.0/);
  });

  test('the file changed by a commit that is not "Release <version>": fail, whatever the message', () => {
    const commits = history('Tweak release/REQUEST.json', 'Release 0.1.0-pre.44');
    const plan = decide({ head: commits[0].sha, commits, markerSha: commits[0].sha, requestText: request, packageVersion: '0.1.0', tagExists: tags() });
    expect(plan.action).toBe('fail');
    // A "Release …" message alone, without the file, is not a release.
    const spoof = history('Release 0.1.0-pre.45');
    expect(decide({ head: spoof[0].sha, commits: spoof, markerSha: null, requestText: null, packageVersion: '0.1.0', tagExists: tags() }).action).toBe('none');
  });

  test('a request older than the window and never tagged: a warning, not a tag', () => {
    const commits = history('Something recent');
    const plan = decide({ head: commits[0].sha, commits, markerSha: sha('f'), requestText: request, packageVersion: '0.1.0', tagExists: tags() });
    expect(plan).toMatchObject({ action: 'none', warning: true });
  });
});

describe('parseRequest and checkPublish', () => {
  test('reads what requestFile writes and refuses anything else', () => {
    expect(parseRequest(request)).toEqual({ version: '0.1.0-pre.44', from: sha('0') });
    expect(parseRequest('{').error).toBeTruthy();
    expect(parseRequest('{"version":"latest"}').error).toBeTruthy();
  });

  test('a publish run checks the tag carries its own request', () => {
    expect(checkPublish({ version: '0.1.0-pre.44', requestText: request, packageVersion: '0.1.0' })).toBeNull();
    expect(checkPublish({ version: '0.1.0-pre.45', requestText: request, packageVersion: '0.1.0' })).toMatch(/carries a request for 0\.1\.0-pre\.44/);
    expect(checkPublish({ version: '0.1.0-pre.44', requestText: null, packageVersion: '0.1.0' })).toMatch(/not cut by release flow v2/);
  });
});
