/**
 * A fixture plugin as an author ships it: packed with `npm pack`, a `link:`
 * devDependency on core that points nowhere, core as a peer, no `buddi.name`,
 * and one dependency that comes from a registry (a fake one, in the test).
 */
import tinyDep from 'tiny-dep';
import { HOST_API_VERSION } from '@buddi/core/plugin';

export const manifest = {
  name: 'packed',
  version: '1.0.0',
  description: 'A fixture: installed from a tarball npm packed.',
  schema: 'packed',
  migrationsDir: '',
  network: [],
  tools: [],
};

export const hostApi = HOST_API_VERSION;
export const dependency = tinyDep;
export default manifest;
