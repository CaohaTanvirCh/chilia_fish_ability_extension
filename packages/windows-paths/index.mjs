import path from 'node:path';
export function normalizeWorkspace(value){
 if(typeof value!=='string'||value.includes('\0')||!path.win32.isAbsolute(value)||(!/^[a-z]:[\\/]/i.test(value)&&!/^\\\\[^\\]+\\[^\\]+/.test(value))) throw new TypeError('Workspace must be an absolute Windows drive or UNC path');
 return path.win32.normalize(value);
}
