/**
 * "Browse…" beside "A directory I built": the folders on the machine buddi
 * runs on, one level at a time, from the owner's home directory down.
 *
 * The browser's own folder picker cannot help here — it gives a page no path,
 * and the page may be open on a phone — so the gateway lists the folders
 * (`GET /api/plugins/folders`) and says which of them hold a package.json.
 * "Use this folder" fills the field; reading it is still "Read it first".
 */
import { useEffect, useState } from 'react';
import { ApiError, api, type PluginFoldersView } from '../../api';
import {
  AppIcon,
  Breadcrumb,
  Button,
  Empty,
  ErrorBanner,
  List,
  ListRow,
  Panel,
  Pill,
  SearchField,
  Sheet,
  Spacer,
  Toolbar,
} from '../../ui';

/** The steps from home to here, each one a place to go back to. */
function steps(view: PluginFoldersView): Array<{ label: string; path: string }> {
  const out = [{ label: 'Home', path: view.home }];
  if (view.path === view.home || !view.path.startsWith(`${view.home}/`)) return out;
  let at = view.home;
  for (const part of view.path.slice(view.home.length + 1).split('/')) {
    at = `${at}/${part}`;
    out.push({ label: part, path: at });
  }
  return out;
}

export function PluginFolders({
  start,
  onPick,
  onClose,
}: {
  /** A path already typed: the list opens there when it can, else at home. */
  start?: string | undefined;
  onPick: (path: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [view, setView] = useState<PluginFoldersView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const go = (path?: string, fallBack = false): void => {
    setFailed(null);
    api
      .pluginFolders(path)
      .then((next) => {
        setView(next);
        setFilter('');
      })
      .catch((error: unknown) => {
        // A typed path that is not a folder under home: start at home instead.
        if (fallBack && path !== undefined) go(undefined);
        else setFailed(error instanceof ApiError ? error.message : String(error));
      });
  };
  useEffect(() => {
    go(start, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const needle = filter.trim().toLowerCase();
  const shown = (view?.folders ?? []).filter((folder) => needle === '' || folder.name.toLowerCase().includes(needle));
  const trail = view ? steps(view) : [];
  return (
    <Sheet
      title="Choose the folder"
      onClose={onClose}
      foot={
        <Toolbar>
          <span className="plugins-foot-note mono">{view?.path ?? ''}</span>
          <Spacer />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" disabled={!view} onClick={() => view && onPick(view.path)}>
            Use this folder
          </Button>
        </Toolbar>
      }
    >
      <p className="plugins-note">
        Folders on the computer buddi runs on, inside your home directory. The one you want holds the plugin&apos;s
        package.json and is already built.
      </p>
      {view ? (
        <Breadcrumb
          label="Folder"
          items={trail.map((step, index) =>
            index === trail.length - 1
              ? { key: step.path, label: step.label, current: true }
              : { key: step.path, label: step.label, onClick: () => go(step.path) },
          )}
        />
      ) : null}
      <SearchField label="Find a folder here" value={filter} placeholder="Find a folder here…" onChange={setFilter} />
      <ErrorBanner message={failed} />
      {!view ? (
        failed ? null : <Empty>Reading the folders…</Empty>
      ) : shown.length === 0 ? (
        <Empty>{needle === '' ? 'No folders in here.' : `No folder here is called anything like “${filter.trim()}”.`}</Empty>
      ) : (
        <Panel flush>
          <List>
            {shown.map((folder) => (
              <ListRow
                key={folder.path}
                onClick={() => go(folder.path)}
                label={`Open ${folder.name}`}
                lead={<AppIcon icon="folder" />}
                title={folder.name}
                side={folder.plugin ? <Pill tone="accent">package.json</Pill> : undefined}
              />
            ))}
          </List>
        </Panel>
      )}
      {view?.truncated ? <p className="plugins-note">Only the first 500 folders are listed; find one by name above.</p> : null}
    </Sheet>
  );
}
