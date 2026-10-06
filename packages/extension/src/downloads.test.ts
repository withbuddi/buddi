/**
 * Agents' downloads in the owner's Chrome: which downloads are an agent's,
 * and what buddi is told about them. Chrome's downloads API is a fake.
 */
import { describe, expect, it } from 'vitest';
import { AgentDownloads, DOWNLOAD_GRACE_MS, type DownloadFrame, type DownloadItemLike, type DownloadsApi } from './downloads.js';

function fakeDownloads(items: DownloadItemLike[] = []) {
  const created: Array<(item: DownloadItemLike) => void> = [];
  const changed: Array<(delta: { id: number; state?: { current?: string } }) => void> = [];
  const api: DownloadsApi = {
    async search({ id }) { return items.filter((item) => item.id === id); },
    onCreated: { addListener: (fn) => { created.push(fn); } },
    onChanged: { addListener: (fn) => { changed.push(fn); } },
  };
  return {
    api, items,
    create: (item: DownloadItemLike) => created.forEach((fn) => fn(item)),
    finish: (id: number, state = 'complete') => changed.forEach((fn) => fn({ id, state: { current: state } })),
  };
}

function setup() {
  const sent: DownloadFrame[] = [];
  let clock = 1_000;
  const watcher = new AgentDownloads({ send: (frame) => sent.push(frame), now: () => clock });
  const chrome = fakeDownloads();
  watcher.attach(chrome.api);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { sent, watcher, chrome, settle, tick: (ms: number) => { clock += ms; } };
}

const statement: DownloadItemLike = {
  id: 7, url: 'https://bank.example/export?token=x', referrer: 'https://bank.example/accounts', filename: '/Users/owner/Downloads/transactions.csv',
  mime: 'text/csv', fileSize: 35_000, state: 'complete',
};

describe('agent downloads in the owner’s Chrome', () => {
  it('hands buddi a download the agent’s click started, with where Chrome saved it', async () => {
    const { sent, watcher, chrome, settle } = setup();
    chrome.items.push(statement);
    watcher.begin('s1', ['https://bank.example/accounts']);
    chrome.create({ ...statement, state: 'in_progress' });
    watcher.end('s1');
    chrome.finish(7);
    await settle();
    expect(sent).toEqual([{ type: 'download', session: 's1', path: '/Users/owner/Downloads/transactions.csv', filename: 'transactions.csv',
      url: 'https://bank.example/export?token=x', mime: 'text/csv', size: 35_000 }]);
  });

  it('leaves the owner’s own downloads alone: no agent acting, another site, another extension', async () => {
    const { sent, watcher, chrome, settle, tick } = setup();
    const news = { ...statement, id: 9, referrer: 'https://news.example/', url: 'https://news.example/a.pdf' };
    const other = { ...statement, id: 10, byExtensionId: 'other' };
    chrome.items.push(statement, { ...statement, id: 8 }, news, other);
    chrome.create({ ...statement, id: 8 }); // nothing armed yet
    watcher.begin('s1', ['https://bank.example/accounts']);
    chrome.create(news);
    chrome.create(other);
    watcher.end('s1');
    tick(DOWNLOAD_GRACE_MS + 1);
    chrome.create(statement); // after the grace: the owner's
    for (const id of [7, 8, 9, 10]) chrome.finish(id);
    await settle();
    expect(sent).toEqual([]);
  });

  it('counts a download that starts a few seconds after the click, and a blob from the page’s site', async () => {
    const { sent, watcher, chrome, settle, tick } = setup();
    const blob = { ...statement, id: 11, referrer: '', url: 'blob:https://bank.example/1f2e', filename: '/Users/owner/Downloads/statement.pdf', mime: 'application/pdf' };
    chrome.items.push(blob);
    watcher.begin('s1', ['https://bank.example/accounts']);
    watcher.end('s1');
    tick(DOWNLOAD_GRACE_MS - 1);
    chrome.create(blob);
    chrome.finish(11);
    await settle();
    expect(sent.map((frame) => frame.filename)).toEqual(['statement.pdf']);
  });

  it('says nothing about an interrupted download, or one whose session ended', async () => {
    const { sent, watcher, chrome, settle } = setup();
    chrome.items.push(statement, { ...statement, id: 12 });
    watcher.begin('s1', ['https://bank.example/']);
    chrome.create(statement);
    chrome.create({ ...statement, id: 12 });
    chrome.finish(7, 'interrupted');
    watcher.forget('s1');
    chrome.finish(12);
    await settle();
    expect(sent).toEqual([]);
  });
});
